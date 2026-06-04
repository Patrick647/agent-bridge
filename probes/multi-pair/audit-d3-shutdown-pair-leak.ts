#!/usr/bin/env bun
/**
 * Audit D3 — daemon shutdown only stops default pair's codex app-server,
 * orphaning other live pairs' children.
 *
 * Spec ref: docs/multi-pair-globals-audit.md §D3.
 *
 * Symptom: in src/daemon.ts:~2096 the SIGTERM handler calls bare
 * `codex.stop()` (module-level → default pair only). Other live pairs'
 * codex children are NOT explicitly stopped. On Unix, child processes
 * become orphans reparented to init when parent dies — they keep
 * running. Per multi-pair crash-isolation design they SHOULD all stop
 * (a daemon-less codex has no bridge to talk to).
 *
 * Expected behavior (post-fix):
 *  - SIGTERM daemon
 *  - All live pairs' codex app-servers exit shortly after
 *
 * Current behavior:
 *  - SIGTERM daemon → default's codex stops cleanly
 *  - Non-default pairs' codex stays alive (orphan)
 *
 * This probe DEMONSTRATES the leak: red until the SIGTERM handler is
 * fixed to iterate `pairs.values()` and stop each one's codex.
 *
 * Note: probe runs `(probe as any).stop()` directly to control the
 * shutdown timing. The runMultiPairProbe finally also calls stop —
 * harmless re-stop on already-dead daemon.
 */
import { execSync } from "node:child_process";
import {
  assert,
  runMultiPairProbe,
  sleep,
} from "./lib";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findPidOnPort(port: number): number | null {
  try {
    const raw = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf-8" }).trim();
    if (!raw) return null;
    const pid = parseInt(raw.split("\n")[0], 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

void runMultiPairProbe("audit-d3", async (probe) => {
  let workCodexPid: number | null = null;
  try {
    // Ensure default + work pairs.
    const defaultPair = await probe.ensurePair("default");
    const workPair = await probe.ensurePair("work");
    await sleep(300);  // let codex app-servers settle on their ports

    const defaultAppPort = parseInt(new URL(defaultPair.appServerUrl).port, 10);
    const workAppPort = parseInt(new URL(workPair.appServerUrl).port, 10);
    const defaultCodexPid = findPidOnPort(defaultAppPort);
    workCodexPid = findPidOnPort(workAppPort);
    assert(defaultCodexPid, `default codex not listening on ${defaultAppPort}`);
    assert(workCodexPid, `work codex not listening on ${workAppPort}`);
    probe.log(`pre-shutdown: default codex pid=${defaultCodexPid}, work codex pid=${workCodexPid}`);

    // SIGTERM the daemon directly. The harness's `stop()` does this
    // (then SIGKILL after 1.2s); we just call it now to get the daemon
    // through its shutdown handler.
    await (probe as any).stop();
    // Brief settle period to let any SIGTERM-cascaded child exit.
    await sleep(1500);

    const defaultAlive = isPidAlive(defaultCodexPid!);
    const workAlive = isPidAlive(workCodexPid!);
    probe.log(`post-shutdown: default codex alive=${defaultAlive}, work codex alive=${workAlive}`);

    // Default should be dead — daemon's shutdown explicitly calls
    // codex.stop() (the module-level / default's adapter).
    assert(!defaultAlive,
      `default codex pid=${defaultCodexPid} survived daemon shutdown — unexpected. ` +
      `Daemon's SIGTERM handler should have called codex.stop().`);

    // CRITICAL ASSERTION (THE D3 LEAK): work codex should ALSO be dead.
    // Current code: daemon shutdown only stops default's codex; work's is
    // orphaned. This probe FAILS until the SIGTERM handler is fixed to
    // iterate pairs.values() and stop each one's codex.
    assert(!workAlive,
      `D3 LEAK CONFIRMED: work codex pid=${workCodexPid} survived daemon shutdown. ` +
      `Multi-pair crash-isolation requires all pairs' codex children to ` +
      `stop when daemon dies. Fix: in src/daemon.ts shutdown handler ` +
      `(~line 2096), iterate \`pairs.values()\` and call \`pair.codex.stop()\` ` +
      `for each.`);

    // After fix lands, workAlive===false → no cleanup needed.
    workCodexPid = null;
  } finally {
    // Defensive cleanup: this probe LEAKS the orphaned work codex on
    // current (red) code. Without this, repeated probe runs accumulate
    // orphan codex processes holding the registered ports, breaking
    // subsequent probes with PAIR_PORTS_BUSY. Once the D3 fix lands the
    // workCodexPid is reset to null above and this is a no-op.
    if (workCodexPid && isPidAlive(workCodexPid)) {
      try {
        process.kill(workCodexPid, "SIGKILL");
        probe.log(`cleanup: SIGKILL'd orphan work codex pid=${workCodexPid}`);
      } catch (err: any) {
        probe.log(`cleanup: failed to kill orphan ${workCodexPid}: ${err?.message ?? err}`);
      }
    }
  }
});
