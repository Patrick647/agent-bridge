#!/usr/bin/env bun
/**
 * M06 — destroy_pair --force on a paired pair, transition to isolated.
 *
 * Spec ref: probes/multi-pair/README.md §M06.
 *
 * Per Codex msg ..._209 ordered plan, M06 is the core lifecycle probe
 * after M04. Verifies that `abg pairs rm work --force --forget` while
 * a Claude is paired with "work" cleanly tears down the pair AND
 * re-homes the paired Claude onto the default pair via
 * transitionToIsolated.
 *
 * Validates:
 *  - Setup: work pair live + paired Claude (FIFO-claimed work)
 *  - destroyPair("work", { force: true, forget: true })
 *    daemon RPC returns pair_destroyed
 *  - Claude receives system_pair_torn_down
 *  - Claude receives system_isolated_ready (fresh ClaudeThread on
 *    default's app-server)
 *  - state.paired flips false; chat is no longer in any pair's
 *    attachedClaudes-with-paired status
 *  - list_pairs no longer includes "work"
 *
 * Note: spec says "mid-turn" but mid-turn requires either real Codex
 * sleep or message timing tricks. This simplified version runs the
 * teardown on a paired-but-idle Claude — covers the core lifecycle
 * contract. A future M06b can add mid-turn variant if needed.
 *
 * Also exercises Issue #83 risk #2 (detachClaudeWs reap uses default
 * proxyTuiSlot) indirectly — if that bug is real, the destroy_pair
 * may leave stale state behind that subsequent list_pairs or attached
 * counts surface.
 */
import {
  assert,
  makeToken,
  runMultiPairProbe,
  sleep,
} from "./lib";

void runMultiPairProbe("m06", async (probe) => {
  // Setup: work pair + TUI + Claude FIFO-paired with it.
  await probe.ensurePair("work");
  const workTui = await probe.connectTuiOnPair("work", makeToken("m06-work"), "tui-work");
  await workTui.initializeAndStartThread();

  const claude = await probe.connectClaudeOnPair("m06_claude");
  const connectResult = await claude.waitForConnectResult();
  assert(connectResult.ok, `claude connect failed: ${connectResult.error ?? "?"}`);
  assert(connectResult.paired === true, `claude should be FIFO-paired with work, got paired=${connectResult.paired}`);
  assert(connectResult.homePairId === "work", `expected homePairId=work, got ${connectResult.homePairId}`);

  // Fire destroy_pair --force --forget on the live, paired pair.
  const destroyResult = await probe.destroyPair("work", { force: true, forget: true });
  assert(destroyResult.type === "pair_destroyed",
    `expected pair_destroyed, got ${destroyResult.type} code=${destroyResult.code ?? "?"} msg="${destroyResult.message ?? ""}"`);
  assert(destroyResult.registryEntryRemoved === true,
    `expected registryEntryRemoved=true (--forget should remove registry entry), got ${destroyResult.registryEntryRemoved}`);
  assert(destroyResult.wasLive === true,
    `expected wasLive=true (work was live before destroy), got ${destroyResult.wasLive}`);
  probe.log(`destroy_pair(work) succeeded: wasLive=${destroyResult.wasLive}, registryEntryRemoved=${destroyResult.registryEntryRemoved}`);

  // Paired Claude must see the torn-down + isolated-transition messages.
  // The two-message contract: first system_pair_torn_down, then
  // system_isolated_ready (or system_isolated_failed if default is
  // not live — default IS live here so we expect ready).
  await claude.waitForContent("system_pair_torn_down", 5_000)
    .catch(() => claude.waitForBridgeMessage(
      (m) => m.id.startsWith("system_pair_torn_down_"),
      "system_pair_torn_down",
      5_000,
    ));
  probe.log(`saw system_pair_torn_down`);

  // Wait for transitionToIsolated to complete — system_isolated_ready
  // emitted when fresh ClaudeThread on default's app-server bootstraps.
  await claude.waitForBridgeMessage(
    (m) => m.id.startsWith("system_isolated_ready_") || m.id.startsWith("system_isolated_failed_"),
    "system_isolated_ready or system_isolated_failed",
    30_000,
  );
  const isolatedOk = claude.bridgeMessages.find((m) =>
    m.id.startsWith("system_isolated_ready_"));
  assert(isolatedOk,
    `expected system_isolated_ready (default is live), did not arrive. ` +
    `got messages: ${claude.bridgeMessages.map((m) => m.id).join(", ")}`);
  probe.log(`saw system_isolated_ready`);

  // Verify pair is gone from list_pairs.
  await sleep(200);
  const pairs = await probe.listPairs();
  const stillThere = pairs.find((p) => p.pairId === "work");
  assert(!stillThere,
    `work should be removed from list_pairs after destroy, still present: ${JSON.stringify(stillThere)}`);

  // Daemon status should reflect chat is now home on default and not
  // paired (transitionToIsolated sets homePairId=default + paired=false).
  // We assert via list_pairs: chat should NOT show up as paired on any
  // pair's attachedClaudes. (It still attaches to the default pair as
  // an unpaired/isolated chat.)
  const defaultEntry = pairs.find((p) => p.pairId === "default");
  assert(defaultEntry, `default pair missing from list_pairs`);
  const isStillPairedSomewhere = pairs.some((p) =>
    p.pairedChatId === "m06_claude");
  assert(!isStillPairedSomewhere,
    `m06_claude should NOT be pairedChatId of any pair after transition, ` +
    `found in: ${pairs.filter((p) => p.pairedChatId === "m06_claude").map((p) => p.pairId).join(", ")}`);
});
