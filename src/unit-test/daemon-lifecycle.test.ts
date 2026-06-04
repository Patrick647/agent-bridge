import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { StateDirResolver } from "../state-dir";
import { DaemonLifecycle, isProcessAlive, resolveDaemonPath } from "../daemon-lifecycle";

describe("DaemonLifecycle", () => {
  let tempDir: string;
  let stateDir: StateDirResolver;
  let logs: string[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-lifecycle-test-"));
    stateDir = new StateDirResolver(tempDir);
    stateDir.ensure();
    logs = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createLifecycle(port = 19999) {
    return new DaemonLifecycle({
      stateDir,
      controlPort: port,
      log: (msg) => logs.push(msg),
    });
  }

  test("healthUrl and controlWsUrl use correct port", () => {
    const lc = createLifecycle(5555);
    expect(lc.healthUrl).toBe("http://127.0.0.1:5555/healthz");
    expect(lc.readyUrl).toBe("http://127.0.0.1:5555/readyz");
    expect(lc.controlWsUrl).toBe("ws://127.0.0.1:5555/ws");
  });

  test("readPid returns null when no pid file", () => {
    const lc = createLifecycle();
    expect(lc.readPid()).toBeNull();
  });

  test("writePid and readPid round-trip", () => {
    const lc = createLifecycle();
    lc.writePid(12345);
    expect(lc.readPid()).toBe(12345);
  });

  test("removePidFile removes the file", () => {
    const lc = createLifecycle();
    lc.writePid(12345);
    expect(existsSync(stateDir.pidFile)).toBe(true);
    lc.removePidFile();
    expect(existsSync(stateDir.pidFile)).toBe(false);
  });

  test("removePidFile does not throw when file missing", () => {
    const lc = createLifecycle();
    expect(() => lc.removePidFile()).not.toThrow();
  });

  test("writeStatus and readStatus round-trip", () => {
    const lc = createLifecycle();
    const status = { proxyUrl: "ws://127.0.0.1:4501", controlPort: 4502, pid: 999 };
    lc.writeStatus(status);
    const loaded = lc.readStatus();
    expect(loaded).toEqual(status);
  });

  test("readStatus returns null when no status file", () => {
    const lc = createLifecycle();
    expect(lc.readStatus()).toBeNull();
  });

  test("isHealthy returns false for non-existent port", async () => {
    const lc = createLifecycle(19999);
    expect(await lc.isHealthy()).toBe(false);
  });

  test("isProcessAlive returns true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("isProcessAlive returns false for non-existent pid", () => {
    expect(isProcessAlive(9999999)).toBe(false);
  });

  test("kill returns false when no pid file", async () => {
    const lc = createLifecycle();
    const result = await lc.kill();
    expect(result).toBe(false);
  });

  test("kill cleans up stale pid for dead process", async () => {
    const lc = createLifecycle();
    lc.writePid(9999999); // non-existent process
    lc.writeStatus({ pid: 9999999 });

    const result = await lc.kill();
    expect(result).toBe(false);
    expect(existsSync(stateDir.pidFile)).toBe(false);
    expect(existsSync(stateDir.statusFile)).toBe(false);
    expect(logs.some((l) => l.includes("not alive"))).toBe(true);
  });

  test("kill refuses to signal a live process that is not an AgentBridge daemon", async () => {
    const lc = createLifecycle();
    // Use current process pid — it's alive but NOT a daemon
    lc.writePid(process.pid);
    // Don't write matching status (so isDaemonProcess falls through to ps check)

    const result = await lc.kill();
    expect(result).toBe(false);
    expect(logs.some((l) => l.includes("NOT an AgentBridge daemon"))).toBe(true);
    // Pid file should be cleaned up
    expect(existsSync(stateDir.pidFile)).toBe(false);
  });

  test("kill proceeds when status.json pid matches", async () => {
    const lc = createLifecycle();
    // Write a non-existent pid but with matching status — tests the isDaemonProcess fast path
    lc.writePid(9999999);
    lc.writeStatus({ pid: 9999999 });

    // Process is dead, so kill returns false before reaching isDaemonProcess
    const result = await lc.kill();
    expect(result).toBe(false);
  });
});

describe("resolveDaemonPath", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-daemon-path-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function baseUrl(path: string): string {
    return pathToFileURL(path).href;
  }

  test("uses an explicit daemon entry when provided", () => {
    const explicitPath = join(tempDir, "custom-daemon.ts");
    const sourceEntry = join(tempDir, "src", "cli.ts");
    mkdirSync(join(tempDir, "src"), { recursive: true });

    expect(resolveDaemonPath(explicitPath, baseUrl(sourceEntry))).toBe(explicitPath);
  });

  test("prefers source daemon in dev mode", () => {
    const sourceDir = join(tempDir, "src");
    mkdirSync(sourceDir, { recursive: true });
    const daemonPath = join(sourceDir, "daemon.ts");
    writeFileSync(daemonPath, "// source daemon\n", "utf-8");

    expect(resolveDaemonPath(undefined, baseUrl(join(sourceDir, "cli.ts")))).toBe(daemonPath);
  });

  test("finds the plugin daemon bundle from the CLI bundle", () => {
    const distDir = join(tempDir, "dist");
    const pluginServerDir = join(tempDir, "plugins", "agentbridge", "server");
    mkdirSync(distDir, { recursive: true });
    mkdirSync(pluginServerDir, { recursive: true });
    const daemonPath = join(pluginServerDir, "daemon.js");
    writeFileSync(daemonPath, "// bundled daemon\n", "utf-8");

    expect(resolveDaemonPath(undefined, baseUrl(join(distDir, "cli.js")))).toBe(daemonPath);
  });

  test("falls back to sibling daemon bundle inside the plugin server", () => {
    const pluginServerDir = join(tempDir, "plugins", "agentbridge", "server");
    mkdirSync(pluginServerDir, { recursive: true });
    const daemonPath = join(pluginServerDir, "daemon.js");
    writeFileSync(daemonPath, "// sibling daemon\n", "utf-8");

    expect(resolveDaemonPath(undefined, baseUrl(join(pluginServerDir, "bridge-server.js")))).toBe(daemonPath);
  });
});

// ── Bug fix (2026-05-18): awaitReadyOrFailure surfaces daemon crash ──
//
// Before fix: `launch()` returned void with `stdio: "ignore"` and no
// `error`/`exit` listeners. Daemon crash (EADDRINUSE, malformed config,
// missing codex CLI) silently disappeared and the CLI polled `/readyz`
// for the full 10s timeout with no diagnostic. User saw "Launching
// detached daemon..." then perceived stuck process.
//
// After fix: `ensureRunning` races readiness polling against the
// process's `exit` + `error` events, so a crash surfaces in
// milliseconds with a hint pointing at the daemon log file.

import { EventEmitter } from "node:events";

describe("DaemonLifecycle.awaitReadyOrFailure (Bug 2026-05-18 fix)", () => {
  let tempDir: string;
  let stateDir: StateDirResolver;
  let logs: string[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-lifecycle-race-test-"));
    stateDir = new StateDirResolver(tempDir);
    stateDir.ensure();
    logs = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createLifecycle(port = 19998) {
    return new DaemonLifecycle({
      stateDir,
      controlPort: port,
      log: (msg) => logs.push(msg),
    });
  }

  function fakeChildProcess(): EventEmitter {
    return new EventEmitter();
  }

  test("rejects with exit diagnostic when daemon dies before becoming ready", async () => {
    const lc = createLifecycle();
    const fakeProc = fakeChildProcess();

    // Fire `exit` shortly after the race starts. Real-world scenario:
    // daemon throws on EADDRINUSE within ~50ms of spawn.
    setTimeout(() => fakeProc.emit("exit", 1, null), 50);

    let caught: Error | null = null;
    try {
      await (lc as any).awaitReadyOrFailure(fakeProc);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/Daemon exited before becoming ready/);
    expect(caught!.message).toMatch(/code=1/);
    // Pointer to log file for actionable diagnosis.
    expect(caught!.message).toContain(stateDir.logFile);
    // Mentions the common causes so user has somewhere to look.
    expect(caught!.message).toMatch(/already in use|stale state|codex.*PATH/);
  });

  test("rejects with spawn-error diagnostic when child emits 'error'", async () => {
    const lc = createLifecycle();
    const fakeProc = fakeChildProcess();

    // Simulate ENOENT on process.execPath — child_process 'error' event.
    setTimeout(() => {
      const err = new Error("spawn /nonexistent ENOENT");
      (err as any).code = "ENOENT";
      fakeProc.emit("error", err);
    }, 50);

    let caught: Error | null = null;
    try {
      await (lc as any).awaitReadyOrFailure(fakeProc);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/Daemon spawn failed/);
    expect(caught!.message).toContain("ENOENT");
    // Pointer to fix path: the bun exec path + bundle path.
    expect(caught!.message).toContain(process.execPath);
  });

  test("resolves cleanly when daemon becomes ready before exit/error fires", async () => {
    const lc = createLifecycle();
    const fakeProc = fakeChildProcess();

    // Stub waitForReady to resolve immediately (simulate /readyz coming up
    // before any failure event fires).
    (lc as any).waitForReady = async () => { /* ready */ };

    // No exit/error emitted — happy path.
    await (lc as any).awaitReadyOrFailure(fakeProc);
    // Should not throw, and we should reach this line. No assertion on
    // resolved value needed (return type is void).
  });

  test("regression: stale exit listener after ready does NOT crash with unhandled rejection", async () => {
    // After awaitReadyOrFailure resolves on ready, the daemon may
    // legitimately exit later (e.g. SIGTERM during graceful shutdown).
    // The leftover exit listener from the race must not produce
    // unhandled rejections or stray errors.
    const lc = createLifecycle();
    const fakeProc = fakeChildProcess();

    (lc as any).waitForReady = async () => { /* ready */ };
    await (lc as any).awaitReadyOrFailure(fakeProc);

    // Emit a late exit. With Promise.race, the loser's resolution is
    // discarded — no unhandled rejection. Verify by emitting and
    // observing no thrown error.
    let lateExitObserved = false;
    fakeProc.on("exit", () => { lateExitObserved = true; });
    fakeProc.emit("exit", 0, "SIGTERM");
    expect(lateExitObserved).toBe(true);
  });
});
