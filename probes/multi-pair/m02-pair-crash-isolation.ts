#!/usr/bin/env bun
/**
 * M02 — pair crash isolation.
 *
 * Spec ref: probes/multi-pair/README.md §M02.
 *
 * Validates that killing one pair's codex app-server doesn't take down
 * the other pair's chat. This is the core promise of multi-pair: real
 * crash isolation between independent Codex sessions.
 *
 * Will likely surface Issue #83 risk #3 (pair-exit handler currently
 * marks ALL chats not-ready, not just chats homed on the crashed pair)
 * — if so, the probe FAILS and that's the right outcome: it tells us
 * the v2.3 isolation claim is real or not.
 *
 * Validates:
 *  - Setup: two pairs (work + side) ensured, two Claudes FIFO-paired
 *    one to each pair
 *  - Kill work's codex app-server (SIGKILL its PID)
 *  - work's pair eventually reports isLive=false in list_pairs
 *  - side's pair stays isLive=true
 *  - side's Claude can still send a reply that round-trips end-to-end
 *    (this is the negative-side assertion — proves crash didn't bleed
 *    over to the other pair's lifecycle state)
 */
import { execSync } from "node:child_process";
import {
  assert,
  makeToken,
  marker,
  runMultiPairProbe,
  sleep,
} from "./lib";

/**
 * Find the PID listening on a given TCP port via lsof. Returns the
 * first matching PID or throws. Used to locate codex app-server PIDs
 * since the daemon's per-pair pid file is for the TUI process, not
 * the app-server it spawns.
 */
function findPidOnPort(port: number): number {
  const url = new URL(`ws://127.0.0.1:${port}`);
  const raw = execSync(`lsof -nP -iTCP:${url.port} -sTCP:LISTEN -t || true`, {
    encoding: "utf-8",
  }).trim();
  if (!raw) throw new Error(`no process listening on 127.0.0.1:${url.port}`);
  const pid = parseInt(raw.split("\n")[0], 10);
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`lsof returned invalid pid for ${url.port}: ${raw}`);
  return pid;
}

void runMultiPairProbe("m02", async (probe) => {
  // Same setup as M01: two pairs, two TUIs, two Claudes FIFO-paired.
  await probe.ensurePair("work");
  await probe.ensurePair("side");
  const workTui = await probe.connectTuiOnPair("work", makeToken("m02-work"), "tui-work");
  await workTui.initializeAndStartThread();
  const sideTui = await probe.connectTuiOnPair("side", makeToken("m02-side"), "tui-side");
  await sideTui.initializeAndStartThread();

  const claudeWork = await probe.connectClaudeOnPair("m02_claude_work");
  await claudeWork.waitForConnectResult();
  const claudeSide = await probe.connectClaudeOnPair("m02_claude_side");
  const sideResult = await claudeSide.waitForConnectResult();
  assert(sideResult.homePairId === "side", `claude #2 expected homePairId=side, got ${sideResult.homePairId}`);

  // Find work's codex app-server PID via lsof on its app-server port.
  // We get the port from the previous ensure_pair response by re-asking.
  const workEnsure = await probe.ensurePair("work");
  const workAppPort = parseInt(new URL(workEnsure.appServerUrl).port, 10);
  const workPid = findPidOnPort(workAppPort);
  probe.log(`killing work codex app-server pid=${workPid} on port ${workAppPort} (SIGKILL)`);

  process.kill(workPid, "SIGKILL");
  // Give the daemon time to notice the exit + propagate isLive=false.
  await sleep(2000);

  const pairsAfter = await probe.listPairs();
  const workAfter = pairsAfter.find((p) => p.pairId === "work");
  const sideAfter = pairsAfter.find((p) => p.pairId === "side");
  assert(workAfter, `list_pairs missing "work" after crash`);
  assert(sideAfter, `list_pairs missing "side" after crash`);
  assert(!workAfter!.isLive, `"work" should be isLive=false after SIGKILL, got isLive=${workAfter!.isLive}`);
  assert(sideAfter!.isLive, `"side" must stay isLive=true after work crashes (crash isolation), got isLive=${sideAfter!.isLive}`);

  // Side's Claude must still be able to send a reply. This is the
  // critical isolation assertion — if Issue #83 risk #3 is real
  // (pair-exit cascade marks all chats not-ready), this will fail
  // with "thread still provisioning" or similar.
  const ok = marker("m02-side-ok");
  const sideReply = await claudeSide.sendReply(
    `Reply with exactly this marker and nothing else: ${ok}`,
    { requireReply: true, timeoutMs: 60_000 },
  );
  assert(sideReply.success, `side's claude reply rejected after work crashed: ${sideReply.error ?? "?"}`);
  await sideTui.waitForAgentMessage(ok, 180_000);
});
