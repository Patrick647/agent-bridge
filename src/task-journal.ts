/**
 * Task journal — minimal review state machine (per Codex review msg
 * ..._289 framing).
 *
 * Scope contract (deliberately narrow):
 *   - task_id, role (implementer / reviewer)
 *   - state machine: drafting → implementing → review_pending →
 *     iterating → approved | rejected | abandoned
 *   - Structured verdict: GO / NEED_REVISION / NO_GO + must_fix list
 *   - NEED_REVISION blocks finalization
 *   - GO required to enter approved state
 *
 * NOT in scope (deferred):
 *   - Auto-commit / auto-rebase / git integration
 *   - Auto agent selection / propose-task magic
 *   - Bridge-protocol-level verdict propagation (filesystem-mediated
 *     for v1; agents read/write via CLI; bridge integration comes after
 *     the contract stabilizes)
 *   - Real-time IPC notifications (agents poll journal or read on demand)
 *
 * Storage: `<project>/.agentbridge/tasks/<task-id>.json`
 * Active task pointer: `<project>/.agentbridge/tasks/active.txt`
 * Rendered markdown view: `<project>/.agentbridge/tasks/<task-id>.md`
 *   (auto-regenerated on every journal mutation; human-readable)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────

export type AgentRole = "claude" | "codex";

export type TaskState =
  | "drafting"          // task created, no implementer assigned yet
  | "implementing"      // implementer working on iteration N
  | "review_pending"    // implementer submitted iteration N, awaiting review
  | "iterating"         // reviewer gave NEED_REVISION, implementer back to work
  | "approved"          // GO verdict received, task done
  | "rejected"          // NO_GO verdict, abandoned
  | "abandoned";        // user gave up / cancelled

export type VerdictDecision = "GO" | "NEED_REVISION" | "NO_GO";

export interface Verdict {
  decision: VerdictDecision;
  reviewer: AgentRole;
  mustFix: string[];
  notes: string;
  reviewedAt: number;
}

export interface Iteration {
  iterationNumber: number;
  implementerOutput: string;  // short summary or pointer to diff/commit
  implementerCommitSha?: string;
  submittedAt: number;
  reviewVerdict?: Verdict;
}

export interface TaskJournal {
  /** Schema version. Bumped on breaking field changes; older readers
   * should refuse / migrate. (Codex review msg ..._296 suggestion —
   * forward-compat for eventual bridge-protocol integration.) */
  schemaVersion: 1;
  taskId: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  implementer?: AgentRole;
  reviewer?: AgentRole;
  state: TaskState;
  iterations: Iteration[];
  finalVerdict?: Verdict;
  abandonReason?: string;
}

// ── Validation: state transitions ──────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<TaskState, TaskState[]> = {
  "drafting":       ["implementing", "abandoned"],
  "implementing":   ["review_pending", "abandoned"],
  "review_pending": ["iterating", "approved", "rejected", "abandoned"],
  "iterating":      ["review_pending", "abandoned"],
  "approved":       [],  // terminal
  "rejected":       [],  // terminal
  "abandoned":      [],  // terminal
};

export function isValidTransition(from: TaskState, to: TaskState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(state: TaskState): boolean {
  return state === "approved" || state === "rejected" || state === "abandoned";
}

// ── Path helpers ────────────────────────────────────────────────────────

function tasksDir(projectRoot: string): string {
  return join(projectRoot, ".agentbridge", "tasks");
}

export function taskJsonPath(projectRoot: string, taskId: string): string {
  return join(tasksDir(projectRoot), `${taskId}.json`);
}

export function taskMdPath(projectRoot: string, taskId: string): string {
  return join(tasksDir(projectRoot), `${taskId}.md`);
}

export function activeTaskPath(projectRoot: string): string {
  return join(tasksDir(projectRoot), "active.txt");
}

// ── Task ID generation ─────────────────────────────────────────────────

/**
 * Slug-style task IDs from user prompts. Lowercase ascii, dash-separated.
 * Falls back to random suffix for empty/non-ascii prompts.
 * Always appends a short hex suffix so concurrent tasks with similar
 * prompts don't collide.
 */
export function generateTaskId(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = randomBytes(2).toString("hex");
  return slug ? `${slug}-${suffix}` : `task-${suffix}`;
}

// ── Read / write journal ────────────────────────────────────────────────

export function readJournal(projectRoot: string, taskId: string): TaskJournal | null {
  const path = taskJsonPath(projectRoot, taskId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TaskJournal;
  } catch {
    return null;
  }
}

export function writeJournal(projectRoot: string, journal: TaskJournal): void {
  const dir = tasksDir(projectRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  journal.updatedAt = Date.now();
  writeFileSync(taskJsonPath(projectRoot, journal.taskId), JSON.stringify(journal, null, 2) + "\n", "utf-8");
  writeFileSync(taskMdPath(projectRoot, journal.taskId), renderMarkdown(journal), "utf-8");
}

export function readActiveTaskId(projectRoot: string): string | null {
  const path = activeTaskPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const id = readFileSync(path, "utf-8").trim();
    return id || null;
  } catch {
    return null;
  }
}

export function writeActiveTaskId(projectRoot: string, taskId: string | null): void {
  const dir = tasksDir(projectRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = activeTaskPath(projectRoot);
  if (taskId === null) {
    if (existsSync(path)) {
      try { unlinkSync(path); } catch { /* best effort */ }
    }
    return;
  }
  writeFileSync(path, taskId + "\n", "utf-8");
}

export function listTaskIds(projectRoot: string): string[] {
  const dir = tasksDir(projectRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

// ── State machine actions ──────────────────────────────────────────────

export class TaskJournalError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "TaskJournalError";
  }
}

export function startTask(
  projectRoot: string,
  prompt: string,
  opts: { implementer?: AgentRole; reviewer?: AgentRole } = {},
): TaskJournal {
  // Codex review msg ..._293: if implementer is provided at start time,
  // auto-advance state to "implementing" so the next-step prompt
  // ("run submit") doesn't crash with INVALID_STATE. Otherwise the
  // start command's friendly hint contradicts the state machine.
  if (opts.implementer && opts.reviewer && opts.implementer === opts.reviewer) {
    throw new TaskJournalError(
      "SAME_ROLE",
      `implementer and reviewer must differ (both set to "${opts.implementer}"). The point of the protocol is two-agent mutual review.`,
    );
  }
  const taskId = generateTaskId(prompt);
  const journal: TaskJournal = {
    schemaVersion: 1,
    taskId,
    prompt,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    implementer: opts.implementer,
    reviewer: opts.reviewer,
    state: opts.implementer ? "implementing" : "drafting",
    iterations: [],
  };
  writeJournal(projectRoot, journal);
  writeActiveTaskId(projectRoot, taskId);
  return journal;
}

/**
 * Set the reviewer for a task. Enforces SAME_ROLE check against the
 * existing implementer so we cannot create a stuck task via the
 * "assign then set reviewer" CLI path. (Codex review msg ..._308.)
 */
export function setReviewer(
  projectRoot: string,
  taskId: string,
  reviewer: AgentRole,
): TaskJournal {
  const journal = readJournal(projectRoot, taskId);
  if (!journal) throw new TaskJournalError("TASK_NOT_FOUND", `Task ${taskId} not found`);
  if (isTerminal(journal.state)) {
    throw new TaskJournalError(
      "INVALID_STATE",
      `Cannot set reviewer in terminal state "${journal.state}"`,
    );
  }
  if (journal.reviewer && journal.reviewer !== reviewer) {
    throw new TaskJournalError(
      "REVIEWER_ALREADY_SET",
      `Task reviewer is already "${journal.reviewer}"; refusing to overwrite with "${reviewer}". Abandon the task and start fresh if you need to change roles.`,
    );
  }
  if (journal.implementer && journal.implementer === reviewer) {
    throw new TaskJournalError(
      "SAME_ROLE",
      `reviewer "${reviewer}" matches existing implementer; the two must differ (mutual review).`,
    );
  }
  journal.reviewer = reviewer;
  writeJournal(projectRoot, journal);
  return journal;
}

export function assignImplementer(
  projectRoot: string,
  taskId: string,
  implementer: AgentRole,
): TaskJournal {
  const journal = readJournal(projectRoot, taskId);
  if (!journal) throw new TaskJournalError("TASK_NOT_FOUND", `Task ${taskId} not found`);
  if (journal.state !== "drafting" && journal.state !== "implementing" && journal.state !== "iterating") {
    throw new TaskJournalError(
      "INVALID_STATE",
      `Cannot assign implementer in state "${journal.state}"`,
    );
  }
  // Codex review msg ..._302 polish: assign path also needs same-role
  // guard. Pre-fix `assign --implementer codex` on a task with
  // reviewer=codex would write a stuck config — later verdict would be
  // blocked by SELF_REVIEW. Reject upfront instead, mirror the
  // startTask same-role check.
  if (journal.reviewer && journal.reviewer === implementer) {
    throw new TaskJournalError(
      "SAME_ROLE",
      `implementer "${implementer}" matches existing reviewer; the two must differ (mutual review).`,
    );
  }
  journal.implementer = implementer;
  if (journal.state === "drafting") {
    if (!isValidTransition(journal.state, "implementing")) {
      throw new TaskJournalError("INVALID_TRANSITION", "drafting → implementing rejected");
    }
    journal.state = "implementing";
  }
  writeJournal(projectRoot, journal);
  return journal;
}

export function submitIteration(
  projectRoot: string,
  taskId: string,
  output: string,
  opts: { commitSha?: string; implementer?: AgentRole } = {},
): TaskJournal {
  const journal = readJournal(projectRoot, taskId);
  if (!journal) throw new TaskJournalError("TASK_NOT_FOUND", `Task ${taskId} not found`);
  if (journal.state !== "implementing" && journal.state !== "iterating") {
    throw new TaskJournalError(
      "INVALID_STATE",
      `Cannot submit iteration in state "${journal.state}". Run \`abg task assign --implementer CLAUDE|CODEX\` first if not yet implementing.`,
    );
  }
  // Codex review msg ..._296: enforce implementer identity. Two cases:
  //   (a) journal.implementer already set: require --as to match.
  //       Without explicit --as we can't tell who's submitting, so the
  //       contract bypass would let either agent claim either side's
  //       work. Hard reject.
  //   (b) journal.implementer not yet set: --as must be provided to
  //       inform who's implementing. If both missing, ambiguous.
  if (journal.implementer) {
    if (!opts.implementer) {
      throw new TaskJournalError(
        "MISSING_AS",
        `Task implementer is "${journal.implementer}"; --as is required to claim that role explicitly.`,
      );
    }
    if (opts.implementer !== journal.implementer) {
      throw new TaskJournalError(
        "WRONG_IMPLEMENTER",
        `Task implementer is "${journal.implementer}", but submission claimed "${opts.implementer}".`,
      );
    }
  } else {
    if (!opts.implementer) {
      throw new TaskJournalError(
        "MISSING_AS",
        `Task has no assigned implementer; --as is required on submit to set it.`,
      );
    }
    journal.implementer = opts.implementer;
  }
  const iteration: Iteration = {
    iterationNumber: journal.iterations.length + 1,
    implementerOutput: output,
    implementerCommitSha: opts.commitSha,
    submittedAt: Date.now(),
  };
  journal.iterations.push(iteration);
  if (!isValidTransition(journal.state, "review_pending")) {
    throw new TaskJournalError("INVALID_TRANSITION", `${journal.state} → review_pending rejected`);
  }
  journal.state = "review_pending";
  writeJournal(projectRoot, journal);
  return journal;
}

export function recordVerdict(
  projectRoot: string,
  taskId: string,
  verdict: Omit<Verdict, "reviewedAt">,
): TaskJournal {
  const journal = readJournal(projectRoot, taskId);
  if (!journal) throw new TaskJournalError("TASK_NOT_FOUND", `Task ${taskId} not found`);
  if (journal.state !== "review_pending") {
    throw new TaskJournalError(
      "INVALID_STATE",
      `Cannot record verdict in state "${journal.state}". Verdicts are only valid on review_pending.`,
    );
  }
  // Attach verdict to the latest iteration.
  const latestIteration = journal.iterations[journal.iterations.length - 1];
  if (!latestIteration) {
    throw new TaskJournalError("NO_ITERATION", "Task has no iterations to review");
  }
  // Codex review msg ..._296: enforce reviewer identity + prohibit self-
  // review. Without these, Codex can self-approve a Codex implementation
  // (reviewer=claude in task journal but verdict claims reviewer=codex →
  // silently accepted pre-fix), which destroys the "mutual review"
  // contract that's the whole point of this state machine.
  if (journal.reviewer && journal.reviewer !== verdict.reviewer) {
    throw new TaskJournalError(
      "WRONG_REVIEWER",
      `Task reviewer is "${journal.reviewer}", but verdict claimed "${verdict.reviewer}".`,
    );
  }
  if (journal.implementer && journal.implementer === verdict.reviewer) {
    throw new TaskJournalError(
      "SELF_REVIEW",
      `Reviewer "${verdict.reviewer}" cannot review their own implementation (implementer="${journal.implementer}"). Mutual review is the whole point.`,
    );
  }
  const fullVerdict: Verdict = { ...verdict, reviewedAt: Date.now() };
  latestIteration.reviewVerdict = fullVerdict;
  if (!journal.reviewer) journal.reviewer = verdict.reviewer;

  // State transition based on decision.
  let nextState: TaskState;
  switch (verdict.decision) {
    case "GO":
      nextState = "approved";
      journal.finalVerdict = fullVerdict;
      break;
    case "NO_GO":
      nextState = "rejected";
      journal.finalVerdict = fullVerdict;
      break;
    case "NEED_REVISION":
      if (verdict.mustFix.length === 0) {
        throw new TaskJournalError(
          "VERDICT_NEEDS_MUST_FIX",
          "NEED_REVISION verdicts must specify at least one must-fix item.",
        );
      }
      nextState = "iterating";
      break;
  }
  if (!isValidTransition(journal.state, nextState)) {
    throw new TaskJournalError("INVALID_TRANSITION", `${journal.state} → ${nextState} rejected`);
  }
  journal.state = nextState;
  writeJournal(projectRoot, journal);
  return journal;
}

export function abandonTask(
  projectRoot: string,
  taskId: string,
  reason: string = "user requested",
): TaskJournal {
  const journal = readJournal(projectRoot, taskId);
  if (!journal) throw new TaskJournalError("TASK_NOT_FOUND", `Task ${taskId} not found`);
  if (isTerminal(journal.state)) {
    // Already terminal — idempotent.
    return journal;
  }
  if (!isValidTransition(journal.state, "abandoned")) {
    throw new TaskJournalError("INVALID_TRANSITION", `${journal.state} → abandoned rejected`);
  }
  journal.state = "abandoned";
  journal.abandonReason = reason;
  writeJournal(projectRoot, journal);
  // Clear active pointer if this was active.
  if (readActiveTaskId(projectRoot) === taskId) {
    writeActiveTaskId(projectRoot, null);
  }
  return journal;
}

// ── Markdown render (for human-readable journal) ───────────────────────

export function renderMarkdown(journal: TaskJournal): string {
  const lines: string[] = [];
  lines.push(`# Task: ${journal.taskId}`);
  lines.push("");
  lines.push(`**State**: ${journal.state}`);
  lines.push(`**Created**: ${new Date(journal.createdAt).toISOString()}`);
  lines.push(`**Updated**: ${new Date(journal.updatedAt).toISOString()}`);
  if (journal.implementer) lines.push(`**Implementer**: ${journal.implementer}`);
  if (journal.reviewer) lines.push(`**Reviewer**: ${journal.reviewer}`);
  lines.push("");
  lines.push("## Prompt");
  lines.push("");
  lines.push(journal.prompt);
  lines.push("");
  if (journal.iterations.length > 0) {
    lines.push(`## Iterations (${journal.iterations.length})`);
    lines.push("");
    for (const it of journal.iterations) {
      lines.push(`### Iteration ${it.iterationNumber}`);
      lines.push("");
      lines.push(`**Submitted**: ${new Date(it.submittedAt).toISOString()}`);
      if (it.implementerCommitSha) lines.push(`**Commit**: \`${it.implementerCommitSha}\``);
      lines.push("");
      lines.push("**Output**:");
      lines.push("");
      lines.push(it.implementerOutput);
      lines.push("");
      if (it.reviewVerdict) {
        lines.push(`**Review verdict**: \`${it.reviewVerdict.decision}\` (by ${it.reviewVerdict.reviewer}, ${new Date(it.reviewVerdict.reviewedAt).toISOString()})`);
        lines.push("");
        if (it.reviewVerdict.mustFix.length > 0) {
          lines.push("**Must-fix**:");
          for (const item of it.reviewVerdict.mustFix) lines.push(`- ${item}`);
          lines.push("");
        }
        if (it.reviewVerdict.notes) {
          lines.push("**Notes**:");
          lines.push("");
          lines.push(it.reviewVerdict.notes);
          lines.push("");
        }
      } else {
        lines.push("_(Awaiting review)_");
        lines.push("");
      }
    }
  }
  if (journal.finalVerdict) {
    lines.push("## Final verdict");
    lines.push("");
    lines.push(`\`${journal.finalVerdict.decision}\` — ${journal.finalVerdict.reviewer} @ ${new Date(journal.finalVerdict.reviewedAt).toISOString()}`);
    if (journal.finalVerdict.notes) {
      lines.push("");
      lines.push(journal.finalVerdict.notes);
    }
    lines.push("");
  }
  if (journal.abandonReason) {
    lines.push("## Abandoned");
    lines.push("");
    lines.push(journal.abandonReason);
    lines.push("");
  }
  return lines.join("\n");
}
