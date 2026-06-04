#!/usr/bin/env bun
/**
 * M06c — paired-not-ready error wording references home pair, not default.
 *
 * Per Codex msg ..._209 plan step 5 (readiness micro-probe). Targets
 * Issue #83 risk #1: the `state.ready === false` paired error wording
 * in handleClaudeToCodex consults the module-level `codex` and
 * `proxyTuiSlot` (default pair's) regardless of the chat's homePairId.
 *
 * Probe strategy (per Codex msg ..._217): deterministically reach
 * paired-not-ready state by connecting TUI but NOT initializing its
 * thread. FIFO claim then sets state.ready=slot.readiness==="ready"
 * → false (slot is "not-ready" because no thread/start yet). Make
 * default's globals deliberately misleading by ensuring default has
 * NO proxy TUI connected, so the old code's fallthrough would emit
 * the wrong message.
 *
 * Validates:
 *  - Setup: ensure default + work pairs live; only work has a TUI
 *    connected (default's proxyTuiSlot is null)
 *  - TUI on work connects but does NOT call thread/start —
 *    work.proxyTuiSlot.readiness stays "not-ready"
 *  - Claude FIFO-pairs work → state.paired=true, state.ready=false
 *  - Send Claude reply → daemon error wording must reference WORK's
 *    pair state (work's slot exists → "still provisioning"), NOT
 *    default's globals (default's slot is null → would have been
 *    "is no longer connected" without fix)
 *
 * Old code (default-globals path) would return "Shared Codex TUI is
 * no longer connected" because default.proxyTuiSlot is null. Fixed
 * code routes through homePair → work.proxyTuiSlot exists →
 * "thread is still provisioning".
 */
import {
  assert,
  makeToken,
  runMultiPairProbe,
  sleep,
} from "./lib";

void runMultiPairProbe("m06c", async (probe) => {
  // Ensure both pairs but connect a TUI only on work — default has
  // no proxy TUI, so default.proxyTuiSlot is null (the misleading
  // default global state).
  await probe.ensurePair("work");
  // Connect TUI to work BUT do not initialize thread → slot stays
  // readiness="not-ready".
  const workTui = await probe.connectTuiOnPair("work", makeToken("m06c-work"), "tui-work");
  // (DELIBERATELY no `await workTui.initializeAndStartThread()`)
  void workTui; // keep ref so it's not GC'd before probe ends

  // Briefly let TUI registration settle.
  await sleep(150);

  // Claude attaches without explicit pairId. FIFO traversal:
  //   - default: no proxyTuiSlot (no TUI) → skip
  //   - work: has slot, unpaired → claim with state.ready=false
  //     (because slot.readiness="not-ready")
  const claude = await probe.connectClaudeOnPair("m06c_claude");
  const result = await claude.waitForConnectResult();
  assert(result.ok, `claude connect failed: ${result.error}`);
  assert(result.homePairId === "work",
    `expected claude to FIFO-claim work, got homePairId=${result.homePairId}`);
  assert(result.paired === true, `expected paired=true, got ${result.paired}`);

  // Send a reply NOW — chat is paired-not-ready, daemon must return
  // the error wording based on WORK's state.
  const reply = await claude.sendReply("racing reply before TUI thread starts");
  assert(reply.success === false,
    `expected reply rejection (paired-not-ready), got success=true`);

  // ── Risk #1 assertion ──────────────────────────────────────────────
  // Default's proxyTuiSlot is null → if daemon consulted DEFAULT (the
  // buggy path), error would be "Shared Codex TUI is no longer connected".
  // Work's proxyTuiSlot EXISTS (TUI is connected, just not thread-started)
  // → correct error should be "Shared Codex TUI thread is still
  // provisioning".
  probe.log(`paired-not-ready error: "${reply.error}"`);
  assert(
    /still provisioning/i.test(reply.error ?? ""),
    `risk #1 failure: error wording should reflect WORK's pair state ` +
    `("still provisioning"), got: "${reply.error}". This means the daemon ` +
    `consulted the default pair's proxyTuiSlot (null) instead of work's ` +
    `(connected but not-ready).`,
  );
  assert(
    !/no longer connected/i.test(reply.error ?? ""),
    `risk #1 failure: error wording references "no longer connected" — ` +
    `that's the wording for default.proxyTuiSlot=null, but the chat is ` +
    `homed on work which HAS a connected proxy TUI`,
  );
  probe.log(`error wording references work's pair state correctly — risk #1 not present`);
});
