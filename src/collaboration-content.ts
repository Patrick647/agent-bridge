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

/** One-line description per preset — single source of truth for
 * `abg init --list-workflows` discovery output. Keep these short and
 * actionable; the actual content lives in the per-preset section
 * constants below. Adding a new preset = add to VALID_WORKFLOW_PRESETS
 * + add the corresponding section constants + describe here. */
export const WORKFLOW_DESCRIPTIONS: Record<WorkflowPreset, string> = {
  "default": "generic 'propose split per task' content; no fixed role assignment",
  "codex-implements": "fixed roles: Codex implements + verifies; Claude designs + reviews + handles git",
};

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

**The state machine is the backbone**. Each turn is a recorded task in \`.agentbridge/tasks/\`. Use the \`abg task ...\` CLI to enforce the review gate — do NOT just chat verdicts via the bridge. Verdicts in chat aren't enforceable; verdicts recorded via \`abg task verdict\` are.

1. **Receive user task** → decide if it's complex enough for split (most non-trivial tasks are). For one-liners, do it solo.

2. **Start the task journal** (records the contract):
   \`\`\`
   abg task start "<one-line prompt>" --implementer codex --reviewer claude
   \`\`\`
   Output gives you the task-id. Most flows use \`active\` shortcut — the most recent task is auto-active.

3. **Plan + brief** → write the plan in chat, send to Codex via \`reply\`: scope, acceptance criteria, file pointers, what NOT to do. Include the task-id so Codex knows which journal to submit against.

4. **Wait for Codex's submit** → don't poll. Codex calls \`abg task submit --output "..." --as codex\` when done (optionally with \`--commit <sha>\` if Codex made one — usually it didn't, since Codex doesn't own git). Check progress with \`abg task status\`.

5. **Read the actual diff** → If a \`--commit\` SHA was reported, \`git diff <sha>~ <sha>\`. Otherwise \`git status\` + \`git diff\` (working tree). Do NOT trust the summary in submit output; verify against the actual change.

6. **Review independently + record verdict via CLI**:
   - For NEED_REVISION: \`abg task verdict NEED_REVISION --as claude --must-fix "specific item 1" --must-fix "..."\`
   - For GO: \`abg task verdict GO --as claude --notes "ship it"\`
   - For NO_GO: \`abg task verdict NO_GO --as claude --notes "fundamentally wrong approach"\`

   NEED_REVISION **requires** at least one \`--must-fix\` item — the CLI rejects empty NEED_REVISION verdicts. GO transitions to approved (terminal). NO_GO is for "abandon this approach entirely".

7. **If NEED_REVISION** → Codex iterates. Watch for next submit; back to step 5. State machine prevents skipping review — Codex cannot self-approve.

8. **GO → you commit + push** → bilingual commit message per project convention. Include \`abg task journal <task-id>\` output in PR body for review evidence.

### Honest reviewer ground rules
- A finding-free review is suspicious. If you can't find anything to push back on, say so explicitly and explain why.
- "I agree with all of it" should be supported by specific reasoning, not blanket assent.
- If Codex's confidence is high and yours is low, ASK for a smaller change you can fully understand before approving.
- **NEED_REVISION is cheap; bad approval is expensive**. When in doubt, send back with a specific must-fix.

### Task journal commands quick reference
| Command | When |
|---|---|
| \`abg task start "..." --implementer codex --reviewer claude\` | Beginning of every multi-agent task |
| \`abg task status [task-id]\` | Check current state |
| \`abg task verdict <GO\\|NEED_REVISION\\|NO_GO> --as claude --must-fix "..."\` | Record review decision (enforced contract) |
| \`abg task journal [task-id]\` | Full markdown history (paste into PR body) |
| \`abg task list\` | All tasks (active + completed + abandoned) |
| \`abg task abandon [task-id] --reason "..."\` | Bail out cleanly |`;

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

**The state machine is the backbone**. Every multi-agent task is a recorded journal at \`.agentbridge/tasks/<task-id>.json\`. Use the \`abg task ...\` CLI to record your submissions — Claude's review is enforced through that journal, NOT through chat-only verdicts.

1. **Wait for Claude's brief** → scope + acceptance criteria + file pointers + the **task-id** Claude started. If unclear or scope missing, push back BEFORE implementing. (Check active task with \`abg task status\`.)

2. **Implement** → make the change; run tests in sandbox; verify locally.

3. **Submit your iteration via the CLI** (this is the enforced contract):
   \`\`\`
   abg task submit --output "<short summary: what changed, what tested, what's NOT covered>" --as codex
   \`\`\`
   - Must pass \`--as codex\` to claim implementer role (CLI rejects without it)
   - \`--commit <sha>\` is **optional** — usually you don't have a SHA because Claude owns git. If you happened to make a commit (rare), include it. Otherwise the working-tree diff is what Claude reviews.
   - Output should be tight — Claude reads it to decide whether to dig into the diff. Lie-resistant; Claude verifies against actual diff anyway.

4. **Wait for Claude's verdict** → Claude calls \`abg task verdict ...\`. Poll with \`abg task status\` to see decision. Three outcomes:
   - **GO**: task approved (terminal). Tell user "ready for commit" — Claude handles git.
   - **NEED_REVISION** + must-fix list: read it (\`abg task status\` shows must-fix items), fix each one, then \`abg task submit\` iteration N+1 with \`--as codex\` again. Loop until GO.
   - **NO_GO**: approach was fundamentally wrong; task rejected (terminal). Discuss with user before retrying with a different approach.

5. **Stop at git boundary** → never run \`git commit\` / \`git push\` / \`git rebase\`. Even after GO. Claude commits using the journal as PR evidence.

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
