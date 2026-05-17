#!/usr/bin/env bun
/**
 * M05 — 3 Claudes, 2 pairs live, FIFO claim with isolated fallback.
 *
 * Spec ref: probes/multi-pair/README.md §M05. Codex msg ..._225 plan
 * step 1 (highest-value remaining probe — covers FIFO saturation +
 * isolated fallback end-to-end).
 *
 * Validates:
 *  - Two pairs ensured (default + work) with --via-proxy TUIs
 *  - Three Claudes attach in sequence WITHOUT explicit pairId
 *  - Claude #1 claims default (insertion order first)
 *  - Claude #2 claims work
 *  - Claude #3 has no free pair to claim → attaches as ISOLATED
 *    (state.paired=false, state.ready stays false until isolated
 *    bootstrap completes against default's app-server, then ready=true)
 *
 * Note: probes the FIFO saturation contract + the isolated fallback
 * path. Real Codex CLI in use because the isolated-fallback bootstrap
 * spawns a fresh ClaudeThread against default's app-server.
 */
import {
  assert,
  makeToken,
  runMultiPairProbe,
} from "./lib";

void runMultiPairProbe("m05", async (probe) => {
  // Ensure default pair (it auto-ensures on first connectTui call) and work.
  const defaultTui = await probe.connectTuiOnPair("default", makeToken("m05-default"), "tui-default");
  await defaultTui.initializeAndStartThread();
  const workTui = await probe.connectTuiOnPair("work", makeToken("m05-work"), "tui-work");
  await workTui.initializeAndStartThread();

  // Claude #1 attaches, FIFO picks default (registry insertion order).
  const claude1 = await probe.connectClaudeOnPair("m05_claude_1");
  const r1 = await claude1.waitForConnectResult();
  assert(r1.ok, `claude1 connect failed: ${r1.error}`);
  assert(r1.paired === true && r1.homePairId === "default",
    `claude1 expected to FIFO-claim default, got paired=${r1.paired} homePairId=${r1.homePairId}`);
  probe.log(`claude1 claimed default`);

  // Claude #2 attaches, FIFO picks work (default is taken).
  const claude2 = await probe.connectClaudeOnPair("m05_claude_2");
  const r2 = await claude2.waitForConnectResult();
  assert(r2.ok, `claude2 connect failed: ${r2.error}`);
  assert(r2.paired === true && r2.homePairId === "work",
    `claude2 expected to FIFO-claim work, got paired=${r2.paired} homePairId=${r2.homePairId}`);
  probe.log(`claude2 claimed work`);

  // Claude #3 attaches — no free pair to claim. Should fall through to
  // isolated bootstrap path (state.paired=false, threads bootstraps
  // against default's app-server).
  const claude3 = await probe.connectClaudeOnPair("m05_claude_3");
  const r3 = await claude3.waitForConnectResult();
  assert(r3.ok, `claude3 connect failed: ${r3.error}`);
  assert(r3.paired === false,
    `claude3 expected to fall through to isolated, got paired=${r3.paired}`);
  // homePairId for isolated chats is "default" — the chat is "homed"
  // there for thread bootstrap, but it's not paired.
  probe.log(`claude3 fell through to isolated (paired=${r3.paired}, homePairId=${r3.homePairId})`);

  // Wait for claude3's isolated thread to bootstrap. The daemon emits
  // either system_thread_ready (per attachClaude bootstrap) — but in
  // this code path the chat bootstraps a fresh ClaudeThread against
  // default's app-server.
  await claude3.waitForDedicatedThreadReady(60_000);
  probe.log(`claude3 isolated thread bootstrapped`);

  // Sanity: list_pairs reflects the 2 paired chats; claude3 should
  // not be pairedChatId of any pair.
  const pairs = await probe.listPairs();
  const def = pairs.find((p) => p.pairId === "default")!;
  const work = pairs.find((p) => p.pairId === "work")!;
  assert(def.pairedChatId === "m05_claude_1",
    `default.pairedChatId expected m05_claude_1, got ${def.pairedChatId}`);
  assert(work.pairedChatId === "m05_claude_2",
    `work.pairedChatId expected m05_claude_2, got ${work.pairedChatId}`);
  const noPairHasClaude3 = pairs.every((p) => p.pairedChatId !== "m05_claude_3");
  assert(noPairHasClaude3,
    `claude3 unexpectedly paired somewhere: ${pairs.filter((p) => p.pairedChatId === "m05_claude_3").map((p) => p.pairId).join(",")}`);
});
