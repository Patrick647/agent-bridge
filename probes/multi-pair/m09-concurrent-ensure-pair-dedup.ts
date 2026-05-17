#!/usr/bin/env bun
/**
 * M09 — concurrent ensure_pair("work") dedup.
 *
 * Spec ref: probes/multi-pair/README.md §M09. Codex msg ..._225 plan
 * step 3 (cheap assurance — backs existing unit coverage for
 * `ensurePairInFlight`).
 *
 * Validates that two simultaneous ensure_pair calls for the same
 * pairId converge on the same allocation (same appServer + proxy
 * URLs) rather than racing into double-spawn.
 *
 * Validates:
 *  - Two ensure_pair("work") fired in parallel from two separate
 *    one-shot WS connections, different requestIds
 *  - Both receive pair_ensured with the SAME appServerUrl + proxyUrl
 *  - Daemon spawns work's codex app-server exactly once (verified
 *    indirectly via port allocation match — if it had spawned twice
 *    the second would fail to bind the same port)
 */
import {
  assert,
  runMultiPairProbe,
} from "./lib";

void runMultiPairProbe("m09", async (probe) => {
  // Fire two ensure_pair("work") in parallel. The harness's
  // controlRpc opens its own WS per call so this is two concurrent
  // RPCs racing through the daemon's pair-registry mutex +
  // ensurePairInFlight dedup.
  const [a, b] = await Promise.all([
    probe.ensurePair("work"),
    probe.ensurePair("work"),
  ]);

  assert(a.appServerUrl === b.appServerUrl,
    `concurrent ensure_pair returned DIFFERENT appServerUrls: a=${a.appServerUrl} b=${b.appServerUrl}`);
  assert(a.proxyUrl === b.proxyUrl,
    `concurrent ensure_pair returned DIFFERENT proxyUrls: a=${a.proxyUrl} b=${b.proxyUrl}`);
  probe.log(`both ensures converged on appServer=${a.appServerUrl} proxy=${a.proxyUrl}`);

  // Sanity: list_pairs has exactly one "work" entry, is live.
  const pairs = await probe.listPairs();
  const workEntries = pairs.filter((p) => p.pairId === "work");
  assert(workEntries.length === 1,
    `expected exactly 1 work entry in list_pairs, got ${workEntries.length}: ${JSON.stringify(workEntries)}`);
  assert(workEntries[0].isLive, `work should be live after concurrent ensure`);
  probe.log(`list_pairs has exactly 1 work entry, live`);
});
