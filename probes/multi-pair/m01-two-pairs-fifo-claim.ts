#!/usr/bin/env bun
/**
 * M01 — two pairs, two Claudes, independent communication.
 *
 * Spec ref: probes/multi-pair/README.md §M01.
 *
 * Validates:
 *  - ensure_pair returns distinct URLs for "work" vs "side"
 *  - TUIs initialize + start threads on each pair's app-server
 *  - Two Claudes attached without an explicit pairId fall through FIFO
 *    claim → first lands on "work", second on "side" (registry insertion
 *    order matches ensure_pair order)
 *  - Each Claude has its own pair / threadId
 *  - Claude #1's reply marker shows up in work's TUI agentMessage stream
 *  - list_pairs reflects both pairs as live + paired with correct
 *    pairedChatId
 *
 * (TUI→Claude direction and cross-pair isolation negative assertion are
 * covered in M02 / M06; here we focus on the FIFO claim contract.)
 */
import {
  assert,
  makeToken,
  marker,
  runMultiPairProbe,
} from "./lib";

void runMultiPairProbe("m01", async (probe) => {
  // Two pairs ensured in deliberate order — work first, side second.
  // FIFO claim should match this insertion order.
  await probe.ensurePair("work");
  await probe.ensurePair("side");

  // Wire up a TUI on each pair, run initialize + thread/start so the
  // proxyTuiSlot transitions to readiness="ready" (claimable state for
  // an unpaired Claude).
  const workTui = await probe.connectTuiOnPair("work", makeToken("m01-work"), "tui-work");
  const workThreadId = await workTui.initializeAndStartThread();

  const sideTui = await probe.connectTuiOnPair("side", makeToken("m01-side"), "tui-side");
  const sideThreadId = await sideTui.initializeAndStartThread();

  assert(workThreadId !== sideThreadId, `work + side threadIds must be distinct, both got ${workThreadId}`);

  // Two Claudes attach with no explicit pairId. FIFO claim contract:
  // first Claude → first live+unpaired pair (work), second → side.
  const claudeWork = await probe.connectClaudeOnPair("m01_claude_work");
  const workResult = await claudeWork.waitForConnectResult();
  assert(workResult.ok, `claude #1 connect failed: ${workResult.error ?? "?"}`);
  assert(workResult.paired === true, `claude #1 should be paired (FIFO claim), got paired=${workResult.paired}`);
  assert(workResult.homePairId === "work", `claude #1 expected homePairId=work, got ${workResult.homePairId}`);

  const claudeSide = await probe.connectClaudeOnPair("m01_claude_side");
  const sideResult = await claudeSide.waitForConnectResult();
  assert(sideResult.ok, `claude #2 connect failed: ${sideResult.error ?? "?"}`);
  assert(sideResult.paired === true, `claude #2 should be paired (FIFO claim), got paired=${sideResult.paired}`);
  assert(sideResult.homePairId === "side", `claude #2 expected homePairId=side, got ${sideResult.homePairId}`);

  // list_pairs reflects the live+paired state.
  const pairs = await probe.listPairs();
  const workEntry = pairs.find((p) => p.pairId === "work");
  const sideEntry = pairs.find((p) => p.pairId === "side");
  assert(workEntry, `list_pairs missing "work"`);
  assert(sideEntry, `list_pairs missing "side"`);
  assert(workEntry!.isLive, `"work" not live`);
  assert(sideEntry!.isLive, `"side" not live`);
  assert(workEntry!.pairedChatId === "m01_claude_work", `work.pairedChatId expected m01_claude_work, got ${workEntry!.pairedChatId}`);
  assert(sideEntry!.pairedChatId === "m01_claude_side", `side.pairedChatId expected m01_claude_side, got ${sideEntry!.pairedChatId}`);

  // Claude #1 sends a marker reply through the bridge into work's
  // shared thread. The marker should surface as an agentMessage in
  // work's TUI (not side's).
  const ok = marker("m01-work-ok");
  const replyResult = await claudeWork.sendReply(
    `Reply with exactly this marker and nothing else: ${ok}`,
    { requireReply: true },
  );
  assert(replyResult.success, `claude #1 reply rejected: ${replyResult.error ?? "?"}`);

  await workTui.waitForAgentMessage(ok, 180_000);
});
