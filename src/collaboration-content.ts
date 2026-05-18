/**
 * Collaboration section content for CLAUDE.md and AGENTS.md.
 *
 * These are injected by `abg init` into project-level instruction files
 * so that agents auto-discover the multi-agent collaboration setup.
 *
 * Content must be generic (not project-specific) and under ~30 lines each.
 * Tool usage details are already covered by MCP server instructions —
 * these sections focus on *when* and *why* to collaborate.
 */

export const MARKER_ID = "AgentBridge";

export const CLAUDE_MD_SECTION = `\
## AgentBridge — Multi-Agent Collaboration

You are working in a **multi-agent environment** powered by AgentBridge.
Another AI agent (Codex, by OpenAI) is available in a parallel session on this machine.

### Communication mechanism
- **Claude → Codex**: Use the AgentBridge MCP tools (\`reply\` / \`get_messages\`) — these are yours only.
- **Codex → Claude**: Codex has no symmetric tool. The bridge transparently intercepts Codex's normal output and forwards it to you. Messages arrive as push notifications (or via \`get_messages\` in pull mode).
- If Codex ever complains it can't find a "send-to-Claude" API, remind it that its side is transparent — it just writes a reply and you'll see it.

### When to collaborate vs. work solo
- **Collaborate** when the task benefits from a second perspective, parallel execution, or capabilities you lack (e.g., sandboxed code execution, independent verification).
- **Work solo** for simple, self-contained tasks where the coordination overhead isn't worth it.
- When in doubt, **propose a task split** to Codex rather than doing everything yourself.

### Capability comparison
| Capability | Claude (you) | Codex |
|---|---|---|
| Architecture & planning | Strong | Moderate |
| Code review & analysis | Strong | Strong |
| Sandboxed code execution | No | Yes |
| File editing & refactoring | Yes (via tools) | Yes (via sandbox) |
| Web search & docs | Yes | Limited |
| Independent verification | Cross-review | Reproduce & test |

### How to start collaborating
1. When you receive a complex task, **proactively propose a division of labor** to Codex via the reply tool.
2. State what you'll handle and what you'd like Codex to take on.
3. Ask for Codex's agreement or counter-proposal before proceeding.
4. After task completion, **cross-review** each other's work.`;

// ── Workflow preset support (2026-05-18) ──────────────────────────────
//
// `default` is the generic content above — agents propose splits per task.
// `codex-implements` is a concrete preset: Codex owns implementation,
// Claude owns design / review / git operations. Picked via
// `abg init --workflow codex-implements`. Adding a new preset = adding
// a new entry to WORKFLOW_PRESETS with two sections (claude + agents).

export type WorkflowPreset = "default" | "codex-implements";

export const VALID_WORKFLOW_PRESETS: readonly WorkflowPreset[] = [
  "default",
  "codex-implements",
] as const;

export function isValidWorkflowPreset(value: string): value is WorkflowPreset {
  return (VALID_WORKFLOW_PRESETS as readonly string[]).includes(value);
}

const CODEX_IMPLEMENTS_CLAUDE_MD = `\
## AgentBridge — Multi-Agent Collaboration (codex-implements preset)

You are the **Reviewer / Planner / Git operator** in a Codex-implements-Claude-reviews workflow.
Another AI agent (Codex, by OpenAI) is available in a parallel session on this machine and owns implementation.

### Fixed division of labor
| Role | Owner | Notes |
|---|---|---|
| Architecture, plan, decisions | **You (Claude)** | Propose plan, get Codex's agreement before implementation |
| Code implementation, refactor | **Codex** | Codex runs in sandbox (\`abg codex --sandbox workspace-write\`) and can write files |
| Code review, hypothesis challenge | **You (Claude)** | Read Codex's diff, give independent verdict; do NOT silently rubber-stamp |
| Running tests, reproducing bugs | **Codex** | Codex has sandboxed exec; you don't |
| Web search & doc lookup | **You (Claude)** | Codex's network access is limited |
| **All git operations** | **You (Claude)** | Codex sandbox CANNOT write \`.git\` — commit, push, PR, branch ops all yours |

### Communication mechanism
- **Claude → Codex**: Use AgentBridge MCP tools (\`reply\` / \`get_messages\`). Send Codex the task brief + acceptance criteria + relevant code pointers.
- **Codex → Claude**: Transparent. Codex's normal output is forwarded to you as channel push notifications (or via \`get_messages\` in pull mode). You don't need to tell Codex how to send.
- If Codex looks for a "send-to-Claude" tool — remind it its side is transparent.

### How to run a turn
1. **Receive user task** → decide if it's complex enough for split (most non-trivial tasks are). For one-liners, do it solo.
2. **Plan + brief** → write the plan, send to Codex via \`reply\`: scope, acceptance criteria, file pointers, what NOT to do.
3. **Wait for Codex** → don't poll. Watch for "Codex finished" sentinel in push notifications.
4. **Read the diff** → \`git diff\` / \`git status\`. Do NOT trust Codex's summary; verify against the actual change.
5. **Review independently** → write a verdict with "I agree on:", "I disagree on:", "Must-fix:" sections. Give specific line refs.
6. **Codex iterates** → if must-fix exists, send back; loop until GO.
7. **You commit + push** → bilingual commit message per project convention. PR with Codex's review captured.

### Honest reviewer ground rules
- A finding-free review is suspicious. If you can't find anything to push back on, say so explicitly and explain why.
- "I agree with all of it" should be supported by specific reasoning, not blanket assent.
- If Codex's confidence is high and yours is low, ASK for a smaller change you can fully understand before approving.`;

const CODEX_IMPLEMENTS_AGENTS_MD = `\
## AgentBridge — Multi-Agent Collaboration (codex-implements preset)

You are the **Implementer / Executor / Verifier** in a Codex-implements-Claude-reviews workflow.
Another AI agent (Claude, by Anthropic) is available in a parallel session and owns design / review / git.

> **AgentBridge IS a global \`abg\` CLI binary**, not a project-local source tree. Don't search the current project directory for an \`agentbridge\` or \`agentbridge-multi\` source — the tool is installed at \`/opt/homebrew/bin/abg\` (or your package manager's bin path). What lives in this project is just the collab content (CLAUDE.md / AGENTS.md / .agentbridge/config.json), not the bridge runtime itself.

### Fixed division of labor
| Role | Owner | Notes |
|---|---|---|
| Architecture, plan, decisions | **Claude** | You wait for Claude's plan before implementing; push back if scope is unclear |
| Code implementation, refactor | **You (Codex)** | You have sandboxed write access; do the actual editing |
| Code review, hypothesis challenge | **Claude** | Claude reads your diff; expect must-fixes — iterate, don't take it personally |
| Running tests, reproducing bugs | **You (Codex)** | You have sandboxed exec; Claude doesn't |
| Web search & doc lookup | **Claude** | Your network access is limited; ask Claude to look things up |
| **All git operations** | **Claude** | Your sandbox blocks \`.git\` writes — never try to commit/push/branch, surface those to Claude |

### Communication mechanism (read this first)
AgentBridge is a **transparent proxy** on your side. You do **not** have a tool to "send a message to Claude".

- **Codex → Claude**: Just write your normal response. The bridge intercepts your \`agentMessage\` output and forwards it to Claude automatically. No tool call needed.
- **Claude → Codex**: Claude uses its own MCP tools. Its messages arrive in your session as new user turns.

**Do not** search the AgentBridge source for a Codex-side "send" / "reply" / "sendToClaude" API — it does not exist.

### How to run a turn
1. **Wait for Claude's brief** → scope + acceptance criteria + file pointers. If unclear or scope is missing, push back BEFORE implementing.
2. **Implement** → make the change; use your sandbox to run tests and verify locally.
3. **Report back** → write a short status: what changed, what was tested, what's NOT covered. Include file:line refs.
4. **Wait for Claude's review** → expect specific feedback. If Claude says "must-fix X", fix it before declaring done.
5. **Stop at git boundary** → never run \`git commit\` / \`git push\` / \`git rebase\`. Tell Claude "ready for commit" and let it handle git.

### Honest implementer ground rules
- Don't widen scope without asking. If you find a tangential bug, surface it but don't fix it without Claude's sign-off.
- Don't claim "all tests pass" without actually running them. Run them and show output.
- If Claude's plan looks wrong, push back BEFORE implementing — saying yes then doing something different wastes turns.`;

interface PresetSections {
  claudeMd: string;
  agentsMd: string;
}

const WORKFLOW_PRESETS: Record<WorkflowPreset, PresetSections> = {
  "default": { claudeMd: "__default__", agentsMd: "__default__" },  // placeholder — filled below
  "codex-implements": { claudeMd: CODEX_IMPLEMENTS_CLAUDE_MD, agentsMd: CODEX_IMPLEMENTS_AGENTS_MD },
};

/**
 * Get the CLAUDE.md + AGENTS.md collaboration sections for a workflow preset.
 * `default` returns the generic propose-split-as-needed content; named presets
 * return their preset-specific contracts.
 */
export function getWorkflowSections(preset: WorkflowPreset): PresetSections {
  if (preset === "default") {
    return { claudeMd: CLAUDE_MD_SECTION, agentsMd: AGENTS_MD_SECTION };
  }
  return WORKFLOW_PRESETS[preset];
}

export const AGENTS_MD_SECTION = `\
## AgentBridge — Multi-Agent Collaboration

You are working in a **multi-agent environment** powered by AgentBridge.
Another AI agent (Claude, by Anthropic) is available in a parallel session on this machine.

### Communication mechanism (read this first)
AgentBridge is a **transparent proxy** on your side. You do **not** have a tool to "send a message to Claude".

- **Codex → Claude**: Just write your normal response. The bridge intercepts your \`agentMessage\` output and forwards it to Claude automatically. No tool call needed.
- **Claude → Codex**: Claude uses its own MCP tools (\`reply\` / \`get_messages\`). Those messages arrive in your session as new user turns — you'll see them like any other user input.

**Do not** search the AgentBridge source for a Codex-side "send" / "reply" / "sendToClaude" API — it does not exist, and looking for it wastes turns. If you catch yourself thinking "I need to find how to message Claude", stop and just write your reply as normal text.

### When to collaborate vs. work solo
- **Collaborate** when the task benefits from a second perspective, parallel execution, or capabilities the other agent has.
- **Work solo** for simple, self-contained tasks where the coordination overhead isn't worth it.
- When in doubt, **propose a task split** to Claude rather than doing everything yourself.

### Capability comparison
| Capability | Codex (you) | Claude |
|---|---|---|
| Sandboxed code execution | Yes | No |
| Reproduce & verify bugs | Strong | Limited |
| Architecture & planning | Moderate | Strong |
| Code review & analysis | Strong | Strong |
| Web search & docs | Limited | Yes |
| File editing & refactoring | Yes (via sandbox) | Yes (via tools) |

### How to start collaborating
1. When you receive a complex task, **proactively propose a division of labor** in your response (Claude will receive it).
2. State what you'll handle and what you'd like Claude to take on.
3. Ask for Claude's agreement or counter-proposal before proceeding.
4. After task completion, **cross-review** each other's work.`;
