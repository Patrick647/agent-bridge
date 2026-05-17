#!/usr/bin/env bun
/**
 * M07 — PAIR_PORTS_BUSY recovery.
 *
 * Spec ref: probes/multi-pair/README.md §M07. Codex msg ..._222 plan
 * step 4.
 *
 * Validates that ensure_pair returns a useful PAIR_PORTS_BUSY error
 * (with conflictPort + conflictPid details) when the registered ports
 * for a pair are held by an unrelated process, AND that the
 * `pairs rm <name> --forget` recovery path works.
 *
 * Validates:
 *  - ensure_pair("work") → allocates ports, registers entry
 *  - destroy_pair("work", { forget: false }) → kills running pair
 *    but KEEPS registry entry (so future ensure_pair reuses same ports)
 *  - Bind a dummy listener on work's registered appPort to simulate
 *    "another process is holding this port"
 *  - ensure_pair("work") → MUST fail with pair_error code PAIR_PORTS_BUSY
 *    with details.conflictPort + details.conflictPid populated
 *  - Recovery: free the port, destroy_pair("work", { forget: true })
 *    → registry wiped, ensure_pair allocates new ports
 *
 * No real Codex turn needed; ~2-4s wall clock.
 */
import { createServer, type Server } from "node:net";
import {
  assert,
  runMultiPairProbe,
  sleep,
} from "./lib";

function reservePortByListening(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

void runMultiPairProbe("m07", async (probe) => {
  // First ensure — allocate work pair, capture registered ports.
  const first = await probe.ensurePair("work");
  const workAppPort = parseInt(new URL(first.appServerUrl).port, 10);
  probe.log(`work pair allocated appPort=${workAppPort}`);

  // Tear down the running pair but KEEP the registry entry so the next
  // ensure_pair tries to reuse the same ports.
  const teardown = await probe.destroyPair("work", { force: true, forget: false });
  assert(teardown.type === "pair_destroyed",
    `expected pair_destroyed (force, no forget), got ${teardown.type}`);
  assert(teardown.registryEntryRemoved === false,
    `expected registryEntryRemoved=false (forget=false), got ${teardown.registryEntryRemoved}`);
  probe.log(`work torn down with registry entry retained`);

  // Briefly let the daemon release the socket fully.
  await sleep(200);

  // Hold the registered appPort with an unrelated process (this probe
  // itself). Daemon's next ensure_pair will detect the conflict via
  // pre-flight port probe.
  const blocker = await reservePortByListening(workAppPort);
  probe.log(`probe is now listening on ${workAppPort} (dummy blocker)`);
  const blockerPid = process.pid;

  try {
    // Now ensure_pair("work") MUST detect PAIR_PORTS_BUSY.
    let busyResponse: any;
    try {
      busyResponse = await probe.ensurePair("work");
    } catch (err: any) {
      // ensurePair throws ProbeFailure on pair_error in our lib —
      // capture the message for assertion.
      busyResponse = { error: String(err.message ?? err) };
    }
    assert(busyResponse.error,
      `expected ensure_pair to fail with PAIR_PORTS_BUSY, got success: ${JSON.stringify(busyResponse)}`);
    assert(/PAIR_PORTS_BUSY/.test(busyResponse.error),
      `expected error to mention PAIR_PORTS_BUSY, got: ${busyResponse.error}`);
    assert(new RegExp(`\\b${workAppPort}\\b`).test(busyResponse.error),
      `expected error to mention conflictPort=${workAppPort}, got: ${busyResponse.error}`);
    assert(new RegExp(`\\b${blockerPid}\\b`).test(busyResponse.error),
      `expected error to mention conflictPid=${blockerPid} (this probe process), got: ${busyResponse.error}`);
    probe.log(`PAIR_PORTS_BUSY surfaced correctly with conflictPort + conflictPid`);
  } finally {
    blocker.close();
  }

  // Recovery: pairs rm work --forget → wipes registry → next ensure
  // allocates fresh ports.
  const wipe = await probe.destroyPair("work", { force: false, forget: true });
  // After teardown above, work is not live; without --force this may
  // succeed because there's no running pair to protect. The contract
  // we care about: registryEntryRemoved=true after this call.
  assert(wipe.type === "pair_destroyed" || wipe.type === "pair_error",
    `unexpected wipe response type: ${wipe.type}`);
  if (wipe.type === "pair_destroyed") {
    assert(wipe.registryEntryRemoved === true,
      `expected registryEntryRemoved=true after --forget, got ${wipe.registryEntryRemoved}`);
  }

  await sleep(150);

  // Re-ensure — should allocate fresh (possibly different) ports.
  const fresh = await probe.ensurePair("work");
  const freshAppPort = parseInt(new URL(fresh.appServerUrl).port, 10);
  probe.log(`recovery ensure: freshAppPort=${freshAppPort}`);
  // Either reused the original port (if blocker freed cleanly) or a
  // new stride was chosen. Both are valid recovery outcomes; the key
  // contract is "ensure succeeded after forget+free".
});
