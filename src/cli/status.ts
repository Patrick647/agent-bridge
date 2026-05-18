/**
 * `abg status` — human-readable snapshot of daemon health + per-pair state.
 *
 * Replaces the workflow of `curl :4502/healthz | python -m json.tool`,
 * which has been a frequent troubleshooting step. Output is structured
 * for terminal reading, not JSON parsing — pipe through `--json` if a
 * machine-readable form is needed.
 */

export async function runStatus(rawArgs: string[]): Promise<void> {
  const wantJson = rawArgs.includes("--json");
  const controlPort = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);

  let data: any;
  try {
    const res = await fetch(`http://127.0.0.1:${controlPort}/healthz`, {
      // Short timeout — if daemon isn't running we want to fail fast,
      // not block on TCP retries.
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      console.error(`AgentBridge daemon: /healthz returned HTTP ${res.status}`);
      process.exit(1);
    }
    data = await res.json();
  } catch (err: any) {
    console.error(`AgentBridge daemon: not reachable on 127.0.0.1:${controlPort}`);
    console.error(`  (${err?.message ?? err})`);
    console.error(``);
    console.error(`To start: \`abg codex\` (spawns daemon + Codex TUI in one step).`);
    process.exit(1);
  }

  if (wantJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`AgentBridge daemon`);
  console.log(`  pid:           ${data.pid}`);
  console.log(`  control port:  127.0.0.1:${controlPort}`);
  console.log(`  bridge ready:  ${data.bridgeReady ? "✅ yes" : "❌ no"}`);
  if (data.daemonCwd !== undefined) {
    console.log(`  daemon cwd:    ${data.daemonCwd}`);
    console.log(`                 (codex app-server inherits this — Codex TUI's "directory" matches)`);
  }
  if (data.codexSandbox !== undefined) {
    if (data.codexSandbox === null) {
      console.log(`  codex sandbox: <default (read-only)>`);
      console.log(`                 (start daemon with \`abg codex --sandbox workspace-write\` to enable writes)`);
    } else {
      console.log(`  codex sandbox: ${data.codexSandbox}`);
    }
  }
  console.log(``);
  console.log(`Top-level aggregate (any live pair)`);
  console.log(`  TUI connected:      ${data.tuiConnected ? "✅" : "✗"}`);
  console.log(`  Proxy TUI attached: ${data.proxyTuiConnected ? "✅" : "✗"}`);
  console.log(`  Active threadId:    ${data.threadId ?? "<none>"}`);
  console.log(`  Attached Claudes:   ${data.attachedClaudeCount ?? 0}`);
  console.log(`  Queued messages:    ${data.queuedMessageCount ?? 0}`);
  console.log(``);

  const pairs = data.pairs ?? [];
  if (pairs.length === 0) {
    console.log(`Pairs: <none>`);
    return;
  }
  console.log(`Pairs (${pairs.length})`);
  for (const p of pairs) {
    const liveMark = p.isLive ? "●" : "○";
    console.log(`  ${liveMark} ${p.pairId}`);
    console.log(`      appServer: ${p.appServerUrl}`);
    console.log(`      proxy:     ${p.proxyUrl}`);
    console.log(`      tui:       ${p.tuiConnected ? "connected" : "—"}  proxy-tui: ${p.proxyTuiConnected ? "yes" : "no"}`);
    console.log(`      paired:    ${p.pairedChatId ?? "<unpaired>"}`);
    console.log(`      threadId:  ${p.threadId ?? "<none>"}`);
    const attached = p.attachedClaudes ?? [];
    if (attached.length === 0) {
      console.log(`      attached:  <none>`);
    } else {
      const pairedList = attached.filter((c: any) => c.paired).map((c: any) => c.chatId);
      const unpairedList = attached.filter((c: any) => !c.paired).map((c: any) => c.chatId);
      console.log(`      attached:  ${attached.length} chat(s)`);
      if (pairedList.length) console.log(`        paired:   ${pairedList.join(", ")}`);
      if (unpairedList.length) console.log(`        isolated: ${unpairedList.join(", ")}`);
    }
  }
  console.log(``);
  console.log(`(Pass --json for machine-readable output.)`);
}
