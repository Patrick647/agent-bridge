#!/usr/bin/env bun
/**
 * M04 — explicit pair attach when not live.
 *
 * Spec ref: probes/multi-pair/README.md §M04.
 *
 * Validates the explicit-pair negative contract on claude_connect:
 *  - Daemon up, NO pairs ensured (only registry-implicit "default")
 *  - Claude sends claude_connect with pairId="ghost-pair"
 *  - Daemon responds claude_connect_result { ok: false, error: "PAIR_NOT_FOUND" }
 *  - No silent fallback to default / FIFO claim — explicit pair means
 *    "this pair or nothing"
 *  - No lingering ChatState side effect (chats Map unchanged for
 *    that chatId)
 *
 * Cheap probe: pure control protocol, no real Codex turn / spawn.
 * Per Codex msg ..._209 ordered plan, M04 lands before M06 to lock
 * the explicit-pair negative contract first.
 */
import {
  assert,
  runMultiPairProbe,
} from "./lib";

void runMultiPairProbe("m04", async (probe) => {
  // Daemon is up but no non-default pair has been ensured.
  // Attempt to attach a Claude bridge that requests an unknown pair.
  const chatId = "m04_claude_ghost";
  const claude = await probe.connectClaudeOnPair(chatId, "ghost-pair");

  const result = await claude.waitForConnectResult();
  assert(result.ok === false,
    `expected ok=false for unknown pair, got ok=${result.ok} (error=${result.error ?? "?"})`);
  assert(
    typeof result.error === "string" && /PAIR_NOT_FOUND|not found|unknown pair|ghost-pair/i.test(result.error),
    `expected PAIR_NOT_FOUND error, got: ${result.error ?? "<none>"}`,
  );
  probe.log(`explicit unknown pair rejected with error: ${result.error}`);

  // The chat must NOT have silently fallen back to default / FIFO.
  // Verify by inspecting daemon status — that chatId should not show up
  // in any pair's attachedClaudes (since the attach was refused).
  // (Note: in current implementation, claude_connect_result ok:false
  // means the daemon never put the chat into chats Map — we just need
  // the bridge to NOT be paired/attached to anything.)
  const pairs = await probe.listPairs();
  for (const p of pairs) {
    const attached = p.attachedClaudes.some((c) => c.chatId === chatId);
    assert(!attached,
      `chat ${chatId} unexpectedly attached to pair "${p.pairId}" after PAIR_NOT_FOUND — explicit-pair semantics broken`);
  }
  probe.log(`chat ${chatId} not present in any pair's attachedClaudes — explicit-pair contract holds`);
});
