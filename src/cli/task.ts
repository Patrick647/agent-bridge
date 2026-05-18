/**
 * `abg task ...` — minimal review state machine CLI.
 *
 * Subcommands (all operate on `<cwd>/.agentbridge/tasks/`):
 *   start <prompt> [--implementer R] [--reviewer R]
 *   assign <task-id|active> --implementer R [--reviewer R]
 *   submit <task-id|active> --output "text" [--commit SHA] [--as R]
 *   verdict <task-id|active> <GO|NEED_REVISION|NO_GO>
 *           --as R [--must-fix "..."] [--notes "..."]
 *   abandon <task-id|active> [--reason "..."]
 *   status [<task-id|active>]
 *   journal <task-id|active>
 *   list
 *
 * "active" resolves to whatever `tasks/active.txt` points at — set by
 * `start` and the latest `status`/`assign`/etc. interaction. Omitting
 * the task-id positional argument also defaults to active.
 */

import {
  startTask,
  assignImplementer,
  submitIteration,
  recordVerdict,
  abandonTask,
  readJournal,
  readActiveTaskId,
  writeActiveTaskId,
  listTaskIds,
  TaskJournalError,
  type AgentRole,
  type VerdictDecision,
  type TaskJournal,
} from "../task-journal";

const VALID_ROLES: readonly string[] = ["claude", "codex"];
const VALID_VERDICTS: readonly string[] = ["GO", "NEED_REVISION", "NO_GO"];

function parseRole(value: string | undefined, flag: string): AgentRole {
  if (!value) {
    console.error(`Error: ${flag} requires a value (claude | codex)`);
    process.exit(1);
  }
  const lower = value.toLowerCase();
  if (!VALID_ROLES.includes(lower)) {
    console.error(`Error: ${flag} must be one of ${VALID_ROLES.join(" | ")} (got "${value}")`);
    process.exit(1);
  }
  return lower as AgentRole;
}

function resolveTaskId(positional: string | undefined, projectRoot: string): string {
  if (positional && positional !== "active") return positional;
  const active = readActiveTaskId(projectRoot);
  if (!active) {
    console.error(`Error: no active task set. Pass an explicit task-id, or run \`abg task start\` first.`);
    process.exit(1);
  }
  return active;
}

function handleError(err: unknown): never {
  if (err instanceof TaskJournalError) {
    console.error(`Error (${err.code}): ${err.message}`);
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}

export async function runTask(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  const projectRoot = process.cwd();

  switch (sub) {
    case "start":
      return runStart(rest, projectRoot);
    case "assign":
      return runAssign(rest, projectRoot);
    case "submit":
      return runSubmit(rest, projectRoot);
    case "verdict":
      return runVerdict(rest, projectRoot);
    case "abandon":
      return runAbandon(rest, projectRoot);
    case "status":
    case undefined:
      return runStatus(rest, projectRoot);
    case "journal":
      return runJournalView(rest, projectRoot);
    case "list":
      return runList(projectRoot);
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`Unknown subcommand: task ${sub}`);
      console.error(`Run \`abg task --help\` for usage.`);
      process.exit(1);
  }
}

function runStart(args: string[], projectRoot: string): void {
  let prompt: string | undefined;
  let implementer: AgentRole | undefined;
  let reviewer: AgentRole | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--implementer") { implementer = parseRole(args[++i], "--implementer"); continue; }
    if (a.startsWith("--implementer=")) { implementer = parseRole(a.slice("--implementer=".length), "--implementer"); continue; }
    if (a === "--reviewer") { reviewer = parseRole(args[++i], "--reviewer"); continue; }
    if (a.startsWith("--reviewer=")) { reviewer = parseRole(a.slice("--reviewer=".length), "--reviewer"); continue; }
    if (prompt === undefined) { prompt = a; continue; }
    // Allow multi-word prompts: concatenate further positionals.
    prompt += " " + a;
  }
  if (!prompt) {
    console.error(`Error: missing prompt. Usage: abg task start "<prompt>" [--implementer R] [--reviewer R]`);
    process.exit(1);
  }
  try {
    const journal = startTask(projectRoot, prompt, { implementer, reviewer });
    console.log(`✅ Task started: ${journal.taskId}`);
    console.log(`   State: ${journal.state}`);
    if (journal.implementer) console.log(`   Implementer: ${journal.implementer}`);
    if (journal.reviewer) console.log(`   Reviewer: ${journal.reviewer}`);
    console.log(``);
    console.log(`Next:`);
    if (!journal.implementer) console.log(`  abg task assign --implementer claude|codex`);
    else console.log(`  abg task submit --output "<diff summary>" --as ${journal.implementer}`);
  } catch (err) { handleError(err); }
}

function runAssign(args: string[], projectRoot: string): void {
  let taskId: string | undefined;
  let implementer: AgentRole | undefined;
  let reviewer: AgentRole | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--implementer") { implementer = parseRole(args[++i], "--implementer"); continue; }
    if (a.startsWith("--implementer=")) { implementer = parseRole(a.slice("--implementer=".length), "--implementer"); continue; }
    if (a === "--reviewer") { reviewer = parseRole(args[++i], "--reviewer"); continue; }
    if (a.startsWith("--reviewer=")) { reviewer = parseRole(a.slice("--reviewer=".length), "--reviewer"); continue; }
    if (taskId === undefined) { taskId = a; continue; }
    console.error(`Error: unexpected argument "${a}"`);
    process.exit(1);
  }
  if (!implementer) {
    console.error(`Error: --implementer required (claude | codex)`);
    process.exit(1);
  }
  const id = resolveTaskId(taskId, projectRoot);
  try {
    const journal = assignImplementer(projectRoot, id, implementer);
    if (reviewer && !journal.reviewer) {
      // Update reviewer via direct edit (no dedicated transition needed).
      journal.reviewer = reviewer;
      // Re-write through public path so updatedAt + markdown refresh.
      const { writeJournal } = require("../task-journal");
      writeJournal(projectRoot, journal);
    }
    console.log(`✅ Task ${id} assigned to ${implementer}${reviewer ? `, reviewer ${reviewer}` : ""}`);
    console.log(`   State: ${journal.state}`);
  } catch (err) { handleError(err); }
}

function runSubmit(args: string[], projectRoot: string): void {
  let taskId: string | undefined;
  let output: string | undefined;
  let commitSha: string | undefined;
  let asRole: AgentRole | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--output") { output = args[++i]; continue; }
    if (a.startsWith("--output=")) { output = a.slice("--output=".length); continue; }
    if (a === "--commit") { commitSha = args[++i]; continue; }
    if (a.startsWith("--commit=")) { commitSha = a.slice("--commit=".length); continue; }
    if (a === "--as") { asRole = parseRole(args[++i], "--as"); continue; }
    if (a.startsWith("--as=")) { asRole = parseRole(a.slice("--as=".length), "--as"); continue; }
    if (taskId === undefined) { taskId = a; continue; }
  }
  if (!output) {
    console.error(`Error: --output "<summary>" required`);
    process.exit(1);
  }
  const id = resolveTaskId(taskId, projectRoot);
  try {
    const journal = submitIteration(projectRoot, id, output, { commitSha, implementer: asRole });
    const latest = journal.iterations[journal.iterations.length - 1];
    console.log(`✅ Task ${id}: iteration ${latest.iterationNumber} submitted`);
    console.log(`   State: ${journal.state}`);
    console.log(``);
    console.log(`Reviewer next:`);
    console.log(`  abg task verdict ${id} GO|NEED_REVISION|NO_GO --as ${journal.reviewer ?? "<claude|codex>"} [--must-fix "..."] [--notes "..."]`);
  } catch (err) { handleError(err); }
}

function runVerdict(args: string[], projectRoot: string): void {
  let taskId: string | undefined;
  let decision: VerdictDecision | undefined;
  let asRole: AgentRole | undefined;
  const mustFix: string[] = [];
  let notes = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--as") { asRole = parseRole(args[++i], "--as"); continue; }
    if (a.startsWith("--as=")) { asRole = parseRole(a.slice("--as=".length), "--as"); continue; }
    if (a === "--must-fix") { mustFix.push(args[++i] ?? ""); continue; }
    if (a.startsWith("--must-fix=")) { mustFix.push(a.slice("--must-fix=".length)); continue; }
    if (a === "--notes") { notes = args[++i] ?? ""; continue; }
    if (a.startsWith("--notes=")) { notes = a.slice("--notes=".length); continue; }
    if (VALID_VERDICTS.includes(a)) { decision = a as VerdictDecision; continue; }
    if (taskId === undefined) { taskId = a; continue; }
  }
  if (!decision) {
    console.error(`Error: missing verdict (one of ${VALID_VERDICTS.join(" / ")})`);
    process.exit(1);
  }
  if (!asRole) {
    console.error(`Error: --as <claude|codex> required (who is reviewing)`);
    process.exit(1);
  }
  const id = resolveTaskId(taskId, projectRoot);
  try {
    const journal = recordVerdict(projectRoot, id, {
      decision,
      reviewer: asRole,
      mustFix: mustFix.filter((m) => m.length > 0),
      notes,
    });
    console.log(`✅ Task ${id}: verdict recorded — ${decision}`);
    console.log(`   State: ${journal.state}`);
    if (journal.state === "approved") {
      console.log(`   🎉 Task approved. Commit + close.`);
    } else if (journal.state === "rejected") {
      console.log(`   ❌ Task rejected. No further iterations.`);
    } else if (journal.state === "iterating" && mustFix.length > 0) {
      console.log(``);
      console.log(`Implementer must-fix:`);
      for (const m of mustFix.filter((x) => x.length > 0)) console.log(`  - ${m}`);
      console.log(``);
      console.log(`Implementer next:`);
      console.log(`  abg task submit ${id} --output "<iteration N+1 summary>" --as ${journal.implementer ?? "<role>"}`);
    }
  } catch (err) { handleError(err); }
}

function runAbandon(args: string[], projectRoot: string): void {
  let taskId: string | undefined;
  let reason = "user requested";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--reason") { reason = args[++i] ?? reason; continue; }
    if (a.startsWith("--reason=")) { reason = a.slice("--reason=".length); continue; }
    if (taskId === undefined) { taskId = a; continue; }
  }
  const id = resolveTaskId(taskId, projectRoot);
  try {
    const journal = abandonTask(projectRoot, id, reason);
    console.log(`Task ${id} marked abandoned (${reason})`);
    console.log(`   State: ${journal.state}`);
  } catch (err) { handleError(err); }
}

function runStatus(args: string[], projectRoot: string): void {
  const id = resolveTaskId(args[0], projectRoot);
  const journal = readJournal(projectRoot, id);
  if (!journal) {
    console.error(`Task ${id} not found.`);
    process.exit(1);
  }
  printShortStatus(journal);
}

function runJournalView(args: string[], projectRoot: string): void {
  const id = resolveTaskId(args[0], projectRoot);
  const journal = readJournal(projectRoot, id);
  if (!journal) {
    console.error(`Task ${id} not found.`);
    process.exit(1);
  }
  // Print the rendered markdown (same content as on-disk .md).
  const { renderMarkdown } = require("../task-journal");
  console.log(renderMarkdown(journal));
}

function runList(projectRoot: string): void {
  const ids = listTaskIds(projectRoot);
  if (ids.length === 0) {
    console.log("No tasks yet. Start one with: abg task start \"<prompt>\"");
    return;
  }
  const active = readActiveTaskId(projectRoot);
  console.log(`Tasks (${ids.length}):`);
  for (const id of ids) {
    const journal = readJournal(projectRoot, id);
    if (!journal) continue;
    const activeMark = id === active ? " ← active" : "";
    console.log(`  ${journal.state.padEnd(15)}  ${id}${activeMark}`);
    console.log(`                   ${journal.prompt.slice(0, 70)}${journal.prompt.length > 70 ? "..." : ""}`);
  }
}

function printShortStatus(journal: TaskJournal): void {
  console.log(`Task ${journal.taskId}`);
  console.log(`  prompt:      ${journal.prompt.slice(0, 80)}${journal.prompt.length > 80 ? "..." : ""}`);
  console.log(`  state:       ${journal.state}`);
  console.log(`  implementer: ${journal.implementer ?? "<unassigned>"}`);
  console.log(`  reviewer:    ${journal.reviewer ?? "<unassigned>"}`);
  console.log(`  iterations:  ${journal.iterations.length}`);
  const latest = journal.iterations[journal.iterations.length - 1];
  if (latest?.reviewVerdict) {
    console.log(`  last verdict: ${latest.reviewVerdict.decision} (by ${latest.reviewVerdict.reviewer})`);
    if (latest.reviewVerdict.mustFix.length > 0) {
      console.log(`  must-fix (${latest.reviewVerdict.mustFix.length}):`);
      for (const m of latest.reviewVerdict.mustFix) console.log(`    - ${m}`);
    }
  } else if (latest) {
    console.log(`  last iteration: ${latest.iterationNumber} (awaiting review)`);
  }
  if (journal.finalVerdict) {
    console.log(`  final verdict: ${journal.finalVerdict.decision}`);
  }
  console.log(``);
  console.log(`Full journal: abg task journal ${journal.taskId}`);
}

function printHelp(): void {
  console.log(`
AgentBridge task review state machine

Workflow:
  start → assign implementer → submit iteration → record verdict
       → (NEED_REVISION) iterate (back to submit)
       → (GO) approved | (NO_GO) rejected

Subcommands (defaults to "status" if no subcommand given):
  abg task start "<prompt>" [--implementer R] [--reviewer R]
                                    # create a new task journal
  abg task assign [task-id] --implementer R [--reviewer R]
                                    # assign roles; auto-transitions drafting → implementing
  abg task submit [task-id] --output "<text>" [--commit SHA] [--as R]
                                    # implementer records iteration N output; → review_pending
  abg task verdict [task-id] GO|NEED_REVISION|NO_GO --as R
                                    [--must-fix "..."]* [--notes "..."]
                                    # reviewer records decision
                                    #   GO → approved (terminal)
                                    #   NO_GO → rejected (terminal)
                                    #   NEED_REVISION → iterating (back to submit)
                                    # NEED_REVISION requires at least one --must-fix.
  abg task abandon [task-id] [--reason "..."]
                                    # mark abandoned (terminal, idempotent)
  abg task status [task-id]         # one-task short summary (default subcommand)
  abg task journal [task-id]        # full rendered markdown of journal
  abg task list                     # all known tasks with state + prompt snippet

Where [task-id] is omitted or "active", the current active task pointer
at \`.agentbridge/tasks/active.txt\` is used.

R ∈ { claude, codex }

Storage:
  .agentbridge/tasks/<task-id>.json    # canonical state
  .agentbridge/tasks/<task-id>.md      # auto-generated markdown view
  .agentbridge/tasks/active.txt        # pointer to current task

Examples:
  abg task start "implement LRU cache with tests" --implementer codex --reviewer claude
  abg task submit --output "cache.ts + cache.test.ts, all 8 tests pass" --commit abc123 --as codex
  abg task verdict NEED_REVISION --as claude --must-fix "missing eviction order test" --must-fix "no thread-safety doc"
  abg task submit --output "added eviction order test (test 9) + doc comment on concurrency" --as codex
  abg task verdict GO --as claude --notes "looks good, commit it"
  abg task list
`.trim());
}
