#!/usr/bin/env bun
/**
 * Audit D1 — top-level DaemonStatus fields reflect default-pair only,
 * even when only a non-default pair is live.
 *
 * Spec ref: docs/multi-pair-globals-audit.md §D1.
 *
 * Symptom: src/daemon.ts:currentStatus() populates the top-level
 * `proxyUrl`, `appServerUrl`, `threadId`, `tuiConnected`,
 * `proxyTuiConnected`, `bridgeReady` from default's adapter / slot /
 * `codexBootstrapped`. A caller hitting /healthz and reading these
 * top-level fields sees default's state, not "what's actually
 * happening in the daemon". Spec §D7 P3 explicitly notes this is v2.2
 * back-compat, but it lies to v2.3 callers who expect aggregate state.
 *
 * Expected behavior (post-fix per audit D1 option B):
 *  - top-level `tuiConnected`/`proxyTuiConnected` → ANY pair's TUI is
 *    connected
 *  - top-level `threadId` → some sensible aggregate (e.g. the most
 *    recent active thread, or null if multiple pairs differ)
 *  - top-level `bridgeReady` → ANY pair is ready to accept replies
 *
 * Current behavior:
 *  - If only "work" pair has a TUI connected and default doesn't, top-
 *    level `tuiConnected=false`, `threadId=null`, `proxyTuiConnected=false`
 *  - But pairs[1] (work) shows tuiConnected=true, threadId=<real>
 *
 * This probe DEMONSTRATES the leak: red until D1 option B (aggregate
 * top-level fields) is implemented.
 */
import {
  assert,
  makeToken,
  runMultiPairProbe,
  sleep,
} from "./lib";

void runMultiPairProbe("audit-d1", async (probe) => {
  // Setup: ONLY work pair gets a TUI. Default has no proxy TUI.
  await probe.ensurePair("work");
  const workTui = await probe.connectTuiOnPair("work", makeToken("audit-d1-work"), "tui-work");
  await workTui.initializeAndStartThread();
  await sleep(300);  // let CodexAdapter's threadId event flush through

  // Read top-level status.
  const status = await probe.status() as any;
  probe.log(`top-level: tuiConnected=${status.tuiConnected}, proxyTuiConnected=${status.proxyTuiConnected}, threadId=${status.threadId}`);

  // pairs[] correctly reflects work's state.
  const workEntry = status.pairs.find((p: any) => p.pairId === "work");
  assert(workEntry, `work pair missing from status.pairs[]`);
  assert(workEntry.proxyTuiConnected === true,
    `pairs[].work.proxyTuiConnected expected true, got ${workEntry.proxyTuiConnected}`);
  probe.log(`pairs[].work: proxyTuiConnected=${workEntry.proxyTuiConnected}, threadId=${workEntry.threadId}`);

  // CRITICAL ASSERTION (THE D1 LEAK): top-level fields should reflect
  // an aggregate ("any pair has a TUI"), not be hardcoded to default's
  // empty state.
  assert(status.proxyTuiConnected === true,
    `D1 LEAK CONFIRMED: top-level proxyTuiConnected=false even though ` +
    `work pair has TUI connected. The top-level field reads from ` +
    `default's proxyTuiSlot which is null. ` +
    `Fix: in currentStatus(), compute as ` +
    `\`pairs.values().some(p => p.proxyTuiSlot !== null)\` instead of ` +
    `bare \`proxyTuiSlot !== null\`.`);

  // Same for threadId — top-level should surface work's threadId, or at
  // minimum NOT be null when some pair has an active thread.
  assert(status.threadId !== null,
    `D1 LEAK CONFIRMED: top-level threadId=null even though work pair ` +
    `has threadId=${workEntry.threadId}. ` +
    `Fix: aggregate from pairs.values(), pick any non-null.`);
});
