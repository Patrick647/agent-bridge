#!/usr/bin/env bun

/**
 * AgentBridge CLI
 *
 * Commands:
 *   agentbridge init        — Install plugin, check deps, generate project config
 *   agentbridge dev         — Register local marketplace + install plugin for local dev
 *   agentbridge claude      — Start Claude Code with AgentBridge plugin flags
 *   agentbridge codex       — Start Codex TUI connected to daemon
 *   agentbridge kill        — Force kill all AgentBridge processes
 */

const args = process.argv.slice(2);
const command = args[0];
const restArgs = args.slice(1);

// Marketplace name constant (shared with plugin)
export const MARKETPLACE_NAME = "agentbridge";
export const PLUGIN_NAME = "agentbridge";

async function main() {
  switch (command) {
    case "init":
      const { runInit } = await import("./cli/init");
      await runInit(restArgs);
      break;
    case "dev":
      const { runDev } = await import("./cli/dev");
      await runDev();
      break;
    case "claude":
      const { runClaude } = await import("./cli/claude");
      await runClaude(restArgs);
      break;
    case "codex":
      const { runCodex } = await import("./cli/codex");
      await runCodex(restArgs);
      break;
    case "kill":
      const { runKill } = await import("./cli/kill");
      await runKill();
      break;
    case "pairs":
      // STM v2.3 §8.2 P4c — pair management subcommands.
      const { runPairs } = await import("./cli/pairs");
      await runPairs(restArgs);
      break;
    case "status":
      // 2026-05-18: human-readable /healthz dump (alternative to
      // `curl :4502/healthz | python -m json.tool`).
      const { runStatus } = await import("./cli/status");
      await runStatus(restArgs);
      break;
    case "task":
      // 2026-05-18: minimal review state machine. See `src/task-journal.ts`.
      const { runTask } = await import("./cli/task");
      await runTask(restArgs);
      break;
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    case "--version":
    case "-v":
      printVersion();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(`Run "agentbridge --help" (or "abg --help") for usage.`);
      process.exit(1);
  }
}

function printHelp() {
  console.log(`
AgentBridge — Multi-agent collaboration bridge

Usage:
  agentbridge <command> [args...]
  abg <command> [args...]

Commands:
  init              Install plugin, check dependencies, generate project config
  dev               Register local marketplace + install plugin (for local dev)
  claude [args...]  Start Claude Code with AgentBridge enabled
                    Use --pair NAME to pre-bind to a specific pair (STM v2.3)
  codex [args...]   Start Codex TUI connected to AgentBridge daemon
                    Use --pair NAME to target a specific pair (STM v2.3)
  pairs <subcmd>    Manage shared-thread pairs (STM v2.3)
                    Subcommands: ls / rm NAME [--forget] [--force] / claim CHAT_ID
  status [--json]   Human-readable daemon health + per-pair snapshot
  task <subcmd>     Review state machine: start / assign / submit / verdict /
                    abandon / status / journal / list
  kill              Force kill all AgentBridge processes

Options:
  --help, -h        Show this help message
  --version, -v     Show version

Examples:
  abg init                                 # First-time setup (default collab content)
  abg init --workflow codex-implements     # Init with Codex-implements / Claude-reviews preset
  abg init --list-workflows                # List all available workflow presets
  abg claude                               # Start Claude Code
  abg claude --resume                      # Start Claude Code and resume session
  abg codex                                # Start Codex TUI (direct mode — bypasses bridge)
  abg codex --via-proxy                    # Start Codex TUI THROUGH bridge proxy (needed
                                           #   for multi-agent collaboration)
  abg codex --model o3                     # Start Codex with specific model
  abg codex --sandbox workspace-write      # Codex with write access (preset-friendly)
  abg status                               # Quick daemon + pair status check
  abg kill                                 # Emergency: kill all processes
`.trim());
}

function printVersion() {
  try {
    const pkg = require("../package.json");
    console.log(`agentbridge v${pkg.version}`);
  } catch {
    console.log("agentbridge (version unknown)");
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
