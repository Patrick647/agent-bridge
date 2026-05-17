#!/usr/bin/env bun
/**
 * M11 — `abg pairs rm` PAIR_BUSY_NOT_FORCED rejection then --force success.
 *
 * Spec ref: probes/multi-pair/README.md §M11. Codex msg ..._222 plan step
 * 3: cheap UX-protection probe.
 *
 * Validates:
 *  - Setup: pair "work" live with paired Claude (FIFO claim)
 *  - destroy_pair("work", { force: false }) → pair_error with
 *    code matching PAIR_BUSY_NOT_FORCED; pair STILL present in
 *    list_pairs (untouched)
 *  - destroy_pair("work", { force: true, forget: true }) → succeeds
 *    (matches M06 behavior, no need to re-assert full transition
 *    here — just confirm the force escape works)
 */
import {
  assert,
  makeToken,
  runMultiPairProbe,
} from "./lib";

void runMultiPairProbe("m11", async (probe) => {
  await probe.ensurePair("work");
  const workTui = await probe.connectTuiOnPair("work", makeToken("m11-work"), "tui-work");
  await workTui.initializeAndStartThread();

  const claude = await probe.connectClaudeOnPair("m11_claude");
  const cr = await claude.waitForConnectResult();
  assert(cr.paired === true && cr.homePairId === "work",
    `claude should FIFO-pair work, got paired=${cr.paired} homePairId=${cr.homePairId}`);

  // Without --force — must be rejected because pair is paired-live.
  const rmNoForce = await probe.destroyPair("work", { force: false });
  assert(rmNoForce.type === "pair_error",
    `expected pair_error without --force, got ${rmNoForce.type}`);
  assert(
    typeof rmNoForce.code === "string" && /PAIR_BUSY_NOT_FORCED|busy|paired/i.test(rmNoForce.code + " " + (rmNoForce.message ?? "")),
    `expected PAIR_BUSY_NOT_FORCED-like rejection, got code=${rmNoForce.code} message="${rmNoForce.message}"`);
  probe.log(`rm without --force correctly rejected: ${rmNoForce.code}`);

  // Pair must be untouched — still in list_pairs as live + paired.
  const pairsAfterRejection = await probe.listPairs();
  const workStill = pairsAfterRejection.find((p) => p.pairId === "work");
  assert(workStill, `work should still be in list_pairs after rejected rm`);
  assert(workStill!.isLive, `work should still be live after rejected rm`);
  assert(workStill!.pairedChatId === "m11_claude",
    `work.pairedChatId should still be m11_claude, got ${workStill!.pairedChatId}`);
  probe.log(`work pair untouched after rejection`);

  // With --force --forget — destroy succeeds.
  const rmForced = await probe.destroyPair("work", { force: true, forget: true });
  assert(rmForced.type === "pair_destroyed",
    `expected pair_destroyed with --force --forget, got ${rmForced.type} code=${rmForced.code}`);
  probe.log(`rm with --force --forget succeeded`);
});
