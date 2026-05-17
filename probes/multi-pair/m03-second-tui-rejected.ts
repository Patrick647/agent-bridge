#!/usr/bin/env bun
/**
 * M03 — second `abg codex --pair work --via-proxy` rejected.
 *
 * Spec ref: probes/multi-pair/README.md §M03.
 *
 * The CLI-level user story is "running `abg codex --pair work --via-proxy`
 * twice in series should exit 1 the second time without disrupting the
 * first TUI". At the proxy WS level, this enforces "one --via-proxy TUI
 * per pair" by rejecting the second connection with close code 4002
 * when the bearer token doesn't match (per spec v2.2 §4.6 + STM v2.3
 * §10 M03).
 *
 * Validates:
 *  - First TUI connects to "work" pair successfully + initializes thread
 *  - Second WS to the same proxy with a DIFFERENT bearer token is
 *    rejected with close code 4002
 *  - First TUI's connection is untouched (still receives messages)
 *  - A separate "side" pair can run its own TUI in parallel
 *    (cross-pair isolation — different proxy port, no rejection)
 */
import { RawWsClient } from "../shared-thread/lib";
import {
  assert,
  makeToken,
  runMultiPairProbe,
  sleep,
} from "./lib";

void runMultiPairProbe("m03", async (probe) => {
  // First --via-proxy TUI on "work" pair.
  const workTokenA = makeToken("m03-work-a");
  const workTui = await probe.connectTuiOnPair("work", workTokenA, "tui-work-a");
  const workThreadId = await workTui.initializeAndStartThread();
  probe.log(`first TUI threadId=${workThreadId} (token=${workTokenA.slice(0, 12)}…)`);

  // Second --via-proxy attempt on the SAME pair with a different token.
  // Resolve work pair's proxy URL via ensure_pair (idempotent — pair is
  // already live so just returns the same URL).
  const workEnsure = await probe.ensurePair("work");
  const workTokenB = makeToken("m03-work-b");
  const secondWs = new RawWsClient(probe, "tui-work-b-attempt", workEnsure.proxyUrl, {
    headers: { authorization: `Bearer ${workTokenB}` },
  });
  // Connect may resolve (Bun accepts WS upgrade) then immediately close,
  // OR reject at upgrade time. Both are valid; we just need to observe
  // the eventual close code.
  try {
    await secondWs.connect(5_000);
  } catch {
    // Upgrade rejected before open — also valid M03 behavior.
  }
  const close = await secondWs.waitForClose(5_000);
  assert(
    close.code === 4002,
    `expected close 4002 (another --via-proxy TUI is already connected), got code=${close.code} reason="${close.reason}"`,
  );
  probe.log(`second TUI rejected with close code ${close.code}: ${close.reason}`);

  // First TUI must still be alive — assert by sending a no-op request
  // and verifying we get a response.
  await sleep(300);
  const noopResp = await workTui.sendRequest("status", undefined, 5_000);
  assert(noopResp.result !== undefined || noopResp.error !== undefined,
    `first TUI's status request should have produced a response, got: ${JSON.stringify(noopResp)}`);
  probe.log("first TUI is still responsive after rejecting the second");

  // A separate pair can host its own --via-proxy TUI in parallel.
  const sideTui = await probe.connectTuiOnPair("side", makeToken("m03-side"), "tui-side");
  const sideThreadId = await sideTui.initializeAndStartThread();
  assert(sideThreadId !== workThreadId, `side and work threadIds should differ, both got ${sideThreadId}`);
  probe.log(`parallel pair side bootstrapped with threadId=${sideThreadId}`);
});
