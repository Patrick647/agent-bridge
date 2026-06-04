#!/usr/bin/env bun
/**
 * M06b — non-default pair claim clears on paired-Claude detach.
 *
 * Per Codex msg ..._209 ordered plan step 4. Targets Issue #83
 * risk #2: `detachClaudeWs` pair-reap path uses the module-level
 * `proxyTuiSlot` (default pair's slot) instead of the chat's home
 * pair's slot. If the bug is real, disconnecting a Claude paired
 * with "work" will fail to clear work's pairedChatId after the
 * reap grace expires.
 *
 * Validates:
 *  - Setup: work pair live + Claude FIFO-paired with work
 *  - Disconnect the Claude bridge WS (close from probe side)
 *  - After PAIR_REAP_MS + slack, work's pairedChatId is null
 *  - A second Claude with no explicit pairId can FIFO-claim work
 *    (the pair is now free again)
 *
 * Uses a short PAIR_REAP_MS via probe env override so the test runs
 * in a few seconds instead of 30s.
 */
import {
  assert,
  makeToken,
  runMultiPairProbe,
  sleep,
} from "./lib";

const REAP_MS = 1000;

void runMultiPairProbe("m06b", async (probe) => {
  // Setup: ensure work pair + TUI + Claude FIFO-paired with work.
  await probe.ensurePair("work");
  const workTui = await probe.connectTuiOnPair("work", makeToken("m06b-work"), "tui-work");
  await workTui.initializeAndStartThread();

  const claude1 = await probe.connectClaudeOnPair("m06b_claude_1");
  const c1Result = await claude1.waitForConnectResult();
  assert(c1Result.paired === true && c1Result.homePairId === "work",
    `claude1 should FIFO-pair work, got paired=${c1Result.paired} homePairId=${c1Result.homePairId}`);

  // Sanity: work's pairedChatId reflects claude1.
  const pairsBefore = await probe.listPairs();
  const workBefore = pairsBefore.find((p) => p.pairId === "work");
  assert(workBefore?.pairedChatId === "m06b_claude_1",
    `work.pairedChatId expected m06b_claude_1, got ${workBefore?.pairedChatId}`);

  // Disconnect claude1's bridge WS. detachClaudeWs runs, schedules
  // pair-reap timer. After REAP_MS elapses, the pair should be back
  // to unpaired.
  probe.log(`closing claude1 WS`);
  claude1.close();

  // Wait for reap + small slack.
  await sleep(REAP_MS + 500);

  const pairsAfter = await probe.listPairs();
  const workAfter = pairsAfter.find((p) => p.pairId === "work");
  assert(workAfter, `work pair missing from list_pairs after detach`);
  assert(workAfter!.pairedChatId === null,
    `work.pairedChatId should be null after Claude detach + reap, ` +
    `got ${workAfter!.pairedChatId}. This is the Issue #83 risk #2 ` +
    `failure mode: detachClaudeWs may be clearing default's slot ` +
    `instead of work's.`);
  probe.log(`work.pairedChatId cleared correctly after reap`);

  // A second Claude with no explicit pairId should FIFO-claim work
  // since it's now the only live unpaired pair (besides default with
  // its own slot — but default's slot is unset in probe harness).
  const claude2 = await probe.connectClaudeOnPair("m06b_claude_2");
  const c2Result = await claude2.waitForConnectResult();
  assert(c2Result.ok, `claude2 connect failed: ${c2Result.error}`);
  assert(c2Result.paired === true,
    `claude2 should FIFO-claim work after claude1 was reaped, got paired=${c2Result.paired}`);
  assert(c2Result.homePairId === "work",
    `claude2 should land on work, got homePairId=${c2Result.homePairId}`);
  probe.log(`claude2 successfully re-claimed work after reap`);
}, {
  pairReapMs: REAP_MS,
});
