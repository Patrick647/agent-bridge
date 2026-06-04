/**
 * Async file logger with size-based rotation.
 *
 * Replaces `appendFileSync` in the hot path. `appendFileSync` was
 * synchronously blocking the event loop on every log line; with a
 * busy proxy producing dozens-to-hundreds of lines per Codex response,
 * that materially slowed end-to-end latency.
 *
 * Design:
 * - One WriteStream per file (process-wide). Multiple call sites
 *   sharing the same log file write through the same stream, so
 *   ordering matches their call order.
 * - `write()` is fire-and-forget. WriteStream's internal buffer
 *   absorbs bursts; drains async to disk. Backpressure (returns
 *   false) is accepted — we don't pause callers, just keep
 *   buffering. Worst case: memory grows briefly until disk catches up.
 * - On `error` we emit to stderr and keep going. A broken log file
 *   never crashes the process — that's how the previous synchronous
 *   `try { appendFileSync(...) } catch {}` pattern behaved too.
 * - `close()` is provided for graceful shutdown — daemon SIGTERM
 *   handler calls it to flush pending lines before exit.
 *
 * Performance note: this is a P0 optimization (2026-05-17). Combined
 * with P1 (proxy frame logs gated behind AGENTBRIDGE_DEBUG_PROXY),
 * the daemon's per-message log overhead drops from O(disk-IO sync)
 * to O(buffer-write) on the hot path.
 *
 * Rotation (2026-05-18 P2): per-file byte counter. When a write would
 * push a file past `LOG_MAX_SIZE_BYTES` (default 50 MB), we rename
 * `path.log` → `path.log.1`, shift `.log.N` → `.log.(N+1)` up to
 * `LOG_BACKUPS` (default 5), drop any beyond, then open a fresh
 * stream at the original path. Rotation is synchronous (renameSync)
 * because writes need a stable target. Daemon SIGTERM-class events
 * are rare; busy daemons rotate every few minutes at most.
 *
 * Historical context: a daemon EPIPE-uncaught-exception loop wrote
 * 8.5 GB to `agentbridge.log` before user noticed (fixed by sticky
 * stderr-broken flag in daemon.ts). Rotation is the operational
 * defense: even if a similar bug reappears, disk impact is bounded
 * by `LOG_MAX_SIZE_BYTES * (LOG_BACKUPS + 1)` (default 300 MB).
 */

import {
  createWriteStream,
  mkdirSync,
  existsSync,
  statSync,
  renameSync,
  unlinkSync,
  type WriteStream,
} from "node:fs";
import { dirname } from "node:path";

export interface AsyncFileLogger {
  write(line: string): void;
  /** Flush + close. Resolves when the underlying stream has finished. */
  close(): Promise<void>;
}

// ── Rotation knobs (env-overridable) ──────────────────────────────────

// `let` not `const` so test suites can override regardless of which
// file imported log-writer first (Bun caches modules across test files,
// so a test setting env after first import otherwise has no effect).
let LOG_MAX_SIZE_BYTES = parseInt(
  process.env.AGENTBRIDGE_LOG_MAX_SIZE_BYTES ?? String(50 * 1024 * 1024),
  10,
);
let LOG_BACKUPS = parseInt(
  process.env.AGENTBRIDGE_LOG_BACKUPS ?? "5",
  10,
);

// ── Per-file state ────────────────────────────────────────────────────

const writers = new Map<string, WriteStream>();
/** Streams that have been rotated away (end() called but flush async).
 * Tracked separately from `writers` so `closeAllAsyncFileLoggers` can
 * await their drain before process exit — pre-fix the rotated stream
 * was simply orphaned from `writers` and a fast shutdown could lose
 * its last buffered lines. (Codex review msg ..._268.) */
const closingStreams = new Set<WriteStream>();
/** Bytes written through THIS process to the file. Bootstrapped from
 * existing file size at open so rotation respects pre-existing content
 * (a 49 MB existing log will rotate on the next 1 MB written, not 49+
 * extra MB). */
const bytesWritten = new Map<string, number>();
/** Flag to prevent reentrant rotation during the rotation itself
 * (defensive — rotation is sync but emits a logging call via the
 * stream error path if rename throws). */
const rotating = new Set<string>();

/** Bootstrap the per-file byte counter from disk on first use of a path.
 * Must run BEFORE the rotation check (a pre-existing 49 MB log should
 * rotate on the next byte, not after another 49 MB of writes). */
function ensureBytesCounterBootstrapped(filePath: string): void {
  if (bytesWritten.has(filePath)) return;
  let initialSize = 0;
  try { initialSize = statSync(filePath).size; } catch { /* file doesn't exist yet */ }
  bytesWritten.set(filePath, initialSize);
}

function getStream(filePath: string): WriteStream {
  const existing = writers.get(filePath);
  if (existing && !existing.destroyed) return existing;
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* race / EACCES — let createWriteStream surface it */ }
  }
  const stream = createWriteStream(filePath, { flags: "a" });
  stream.on("error", (err) => {
    process.stderr.write(`[log-writer] write error on ${filePath}: ${err.message}\n`);
  });
  writers.set(filePath, stream);
  return stream;
}

/**
 * Rotate `path.log` → `path.log.1`, shift older backups one slot,
 * drop any beyond `LOG_BACKUPS`, then open a fresh stream at the
 * original path. Sync because writes need a stable target during
 * the swap.
 */
function rotateFile(filePath: string): void {
  if (rotating.has(filePath)) return;
  rotating.add(filePath);
  try {
    // Close + drop the current stream first so the rename can succeed
    // on platforms where open files lock the inode (mostly Windows; on
    // Unix this is harmless but conceptually correct).
    //
    // Track the rotated-away stream in `closingStreams` so a fast
    // daemon shutdown via closeAllAsyncFileLoggers awaits its flush
    // instead of orphaning the last few buffered lines. (Codex review
    // msg ..._268.)
    const current = writers.get(filePath);
    if (current && !current.destroyed) {
      closingStreams.add(current);
      try {
        current.end(() => closingStreams.delete(current));
      } catch {
        closingStreams.delete(current);
      }
    }
    writers.delete(filePath);

    // Drop the oldest backup if it exists.
    const oldest = `${filePath}.${LOG_BACKUPS}`;
    if (existsSync(oldest)) {
      try { unlinkSync(oldest); } catch (err: any) {
        process.stderr.write(`[log-writer] failed to delete oldest backup ${oldest}: ${err?.message ?? err}\n`);
      }
    }

    // Shift backups N-1 → N, N-2 → N-1, ..., 1 → 2.
    for (let i = LOG_BACKUPS - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      if (existsSync(src)) {
        try { renameSync(src, dst); } catch (err: any) {
          process.stderr.write(`[log-writer] failed to rotate ${src} → ${dst}: ${err?.message ?? err}\n`);
        }
      }
    }

    // Current → .1 (only if it exists; might not on first rotation
    // after a fresh start where bytesWritten counter caught up).
    if (existsSync(filePath)) {
      try { renameSync(filePath, `${filePath}.1`); } catch (err: any) {
        process.stderr.write(`[log-writer] failed to rotate ${filePath} → ${filePath}.1: ${err?.message ?? err}\n`);
      }
    }

    // Reset counter; new stream opens lazily on next write.
    bytesWritten.set(filePath, 0);
  } finally {
    rotating.delete(filePath);
  }
}

export function getAsyncFileLogger(filePath: string): AsyncFileLogger {
  return {
    write(line: string): void {
      // Bootstrap counter from disk BEFORE the rotation check — a
      // pre-existing log file's size must be considered when deciding
      // whether THIS write triggers rotation.
      ensureBytesCounterBootstrapped(filePath);
      const lineSize = Buffer.byteLength(line, "utf8");
      if ((bytesWritten.get(filePath) ?? 0) + lineSize > LOG_MAX_SIZE_BYTES) {
        rotateFile(filePath);
      }
      const stream = getStream(filePath);
      try {
        stream.write(line);
        bytesWritten.set(filePath, (bytesWritten.get(filePath) ?? 0) + lineSize);
      } catch (err: any) {
        // Defensive: if the stream is somehow in a bad state, fall back
        // to stderr without crashing.
        process.stderr.write(`[log-writer] sync write failed on ${filePath}: ${err?.message ?? err}\n`);
      }
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        const stream = writers.get(filePath);
        if (!stream || stream.destroyed) { resolve(); return; }
        writers.delete(filePath);
        bytesWritten.delete(filePath);
        stream.end(() => resolve());
      });
    },
  };
}

/** Close all open file loggers — used by SIGTERM handlers for clean flush.
 * Awaits both currently-open streams AND any rotated-away streams still
 * draining to disk, so the last few buffered lines aren't lost on a
 * fast shutdown that races a recent rotation. */
export async function closeAllAsyncFileLoggers(): Promise<void> {
  const all = [...writers.entries()];
  const closing = [...closingStreams];
  writers.clear();
  closingStreams.clear();
  bytesWritten.clear();
  const pendingActive = all.map(([_path, stream]) =>
    new Promise<void>((resolve) => {
      if (stream.destroyed) { resolve(); return; }
      stream.end(() => resolve());
    }),
  );
  const pendingClosing = closing.map((stream) =>
    new Promise<void>((resolve) => {
      // already ended in rotateFile; just wait for the underlying file
      // descriptor to actually drain. listening for 'finish' is the
      // safest signal; fall back to 'close' for older Node.
      if (stream.destroyed) { resolve(); return; }
      const done = () => resolve();
      stream.once("finish", done);
      stream.once("close", done);
    }),
  );
  await Promise.all([...pendingActive, ...pendingClosing]);
}

/** Exposed for tests — pure function inspecting current state. */
export function _testingState() {
  return {
    bytesWritten: new Map(bytesWritten),
    LOG_MAX_SIZE_BYTES,
    LOG_BACKUPS,
  };
}

/** Test-only: override rotation knobs at runtime so the log-writer
 * test can set small thresholds regardless of which other test file
 * already imported this module first (Bun shares module cache across
 * test files, so module-load env capture is order-dependent). */
export function _testingSetConstants(opts: { maxSize?: number; backups?: number }) {
  if (opts.maxSize !== undefined) LOG_MAX_SIZE_BYTES = opts.maxSize;
  if (opts.backups !== undefined) LOG_BACKUPS = opts.backups;
}
