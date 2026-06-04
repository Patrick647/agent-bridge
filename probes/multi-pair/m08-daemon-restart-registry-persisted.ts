#!/usr/bin/env bun
/**
 * M08 — daemon restart with persisted registry.
 *
 * Spec ref: probes/multi-pair/README.md §M08. Codex msg ..._225 plan
 * step 2.
 *
 * Validates pair-registry persistence + port-reuse semantics across
 * daemon restarts. After `abg kill && bun src/daemon.ts`:
 *  - pairs/registry.json on disk survives
 *  - list_pairs shows all previously-allocated pairs with isLive=false
 *    (registry entries known, but no codex process running yet)
 *  - ensure_pair(<existing>) rehydrates with the SAME ports as before
 *    the restart (registry-backed allocation)
 *
 * Validates:
 *  - Ensure work + side pairs (allocates ports, writes registry)
 *  - Capture allocated ports
 *  - Restart daemon (SIGTERM + spawn fresh against same state dir)
 *  - list_pairs shows work + side with isLive=false
 *  - ensure_pair("work") returns SAME ports as before restart
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assert,
  runMultiPairProbe,
  sleep,
} from "./lib";

void runMultiPairProbe("m08", async (probe) => {
  // Pre-restart: allocate work + side, capture ports.
  const workBefore = await probe.ensurePair("work");
  const sideBefore = await probe.ensurePair("side");
  const workAppPort = parseInt(new URL(workBefore.appServerUrl).port, 10);
  const sideAppPort = parseInt(new URL(sideBefore.appServerUrl).port, 10);
  probe.log(`pre-restart: work appPort=${workAppPort}, side appPort=${sideAppPort}`);

  // Verify registry file exists on disk.
  const registryPath = join(probe.stateDir, "pairs", "registry.json");
  assert(existsSync(registryPath), `registry file missing at ${registryPath}`);
  const registryBefore = JSON.parse(readFileSync(registryPath, "utf-8"));
  probe.log(`registry pre-restart: ${JSON.stringify(registryBefore.entries.map((e: any) => `${e.pairId}@${e.appPort}`))}`);

  // Restart the daemon. State dir (including registry) preserved.
  await probe.restartDaemon();
  await sleep(300);

  // Post-restart: registry file should still exist with same entries.
  assert(existsSync(registryPath), `registry file missing after restart`);
  const registryAfter = JSON.parse(readFileSync(registryPath, "utf-8"));
  assert(registryAfter.entries.length === registryBefore.entries.length,
    `registry entry count changed: before=${registryBefore.entries.length} after=${registryAfter.entries.length}`);

  // list_pairs should show the registered pairs (work + side) as
  // not-live since no codex is currently running for them. The
  // default pair gets re-ensured by the daemon's own boot path.
  const pairsAfter = await probe.listPairs();
  const workEntry = pairsAfter.find((p) => p.pairId === "work");
  const sideEntry = pairsAfter.find((p) => p.pairId === "side");
  assert(workEntry, `list_pairs missing "work" after restart`);
  assert(sideEntry, `list_pairs missing "side" after restart`);
  assert(!workEntry!.isLive,
    `expected work to be NOT live after restart (no codex spawned for it), got isLive=${workEntry!.isLive}`);
  assert(!sideEntry!.isLive,
    `expected side to be NOT live after restart, got isLive=${sideEntry!.isLive}`);
  probe.log(`registry entries survived restart with isLive=false`);

  // ensure_pair("work") again — must reuse the SAME ports from registry.
  const workAfter = await probe.ensurePair("work");
  const workAppPortAfter = parseInt(new URL(workAfter.appServerUrl).port, 10);
  assert(workAppPortAfter === workAppPort,
    `port-reuse contract broken: work appPort was ${workAppPort} pre-restart, now ${workAppPortAfter} after rehydrate`);
  probe.log(`work rehydrated on same appPort=${workAppPortAfter}`);
});
