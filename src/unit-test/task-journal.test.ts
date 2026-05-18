/**
 * Unit tests for the task journal state machine (2026-05-18).
 *
 * Coverage:
 *   - Happy path: start → assign → submit → GO → approved
 *   - NEED_REVISION loop: must-fix required, blocks finalization
 *   - NO_GO terminal
 *   - Invalid transitions rejected
 *   - Disk persistence + markdown render
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  isValidTransition,
  isTerminal,
  generateTaskId,
  TaskJournalError,
} from "../task-journal";

describe("task-journal: state machine + transitions", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "abg-task-test-"));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("happy path: start → assign → submit → GO", () => {
    const j1 = startTask(projectRoot, "implement LRU cache", { implementer: "codex", reviewer: "claude" });
    expect(j1.state).toBe("drafting");

    const j2 = assignImplementer(projectRoot, j1.taskId, "codex");
    expect(j2.state).toBe("implementing");

    const j3 = submitIteration(projectRoot, j1.taskId, "cache.ts + tests, 8/8 pass", { commitSha: "abc123" });
    expect(j3.state).toBe("review_pending");
    expect(j3.iterations.length).toBe(1);
    expect(j3.iterations[0].iterationNumber).toBe(1);

    const j4 = recordVerdict(projectRoot, j1.taskId, {
      decision: "GO",
      reviewer: "claude",
      mustFix: [],
      notes: "looks good",
    });
    expect(j4.state).toBe("approved");
    expect(j4.finalVerdict?.decision).toBe("GO");
    expect(isTerminal(j4.state)).toBe(true);
  });

  test("NEED_REVISION loop: must-fix required + iterates back to submit", () => {
    const j1 = startTask(projectRoot, "build thing");
    assignImplementer(projectRoot, j1.taskId, "codex");
    submitIteration(projectRoot, j1.taskId, "first attempt");

    // NEED_REVISION without must-fix should error.
    expect(() => recordVerdict(projectRoot, j1.taskId, {
      decision: "NEED_REVISION",
      reviewer: "claude",
      mustFix: [],
      notes: "",
    })).toThrow(/at least one must-fix/);

    // With must-fix → iterating.
    const j2 = recordVerdict(projectRoot, j1.taskId, {
      decision: "NEED_REVISION",
      reviewer: "claude",
      mustFix: ["fix X", "fix Y"],
      notes: "see comments",
    });
    expect(j2.state).toBe("iterating");
    expect(j2.finalVerdict).toBeUndefined();  // NEED_REVISION isn't final
    expect(j2.iterations[0].reviewVerdict?.mustFix).toEqual(["fix X", "fix Y"]);

    // Submit iteration 2 → back to review_pending.
    const j3 = submitIteration(projectRoot, j1.taskId, "fixed X and Y");
    expect(j3.state).toBe("review_pending");
    expect(j3.iterations.length).toBe(2);

    // GO on iteration 2.
    const j4 = recordVerdict(projectRoot, j1.taskId, {
      decision: "GO",
      reviewer: "claude",
      mustFix: [],
      notes: "great",
    });
    expect(j4.state).toBe("approved");
    expect(j4.iterations[1].reviewVerdict?.decision).toBe("GO");
  });

  test("NO_GO: terminal rejection, no more iterations", () => {
    const j = startTask(projectRoot, "doomed task");
    assignImplementer(projectRoot, j.taskId, "codex");
    submitIteration(projectRoot, j.taskId, "attempt");
    const final = recordVerdict(projectRoot, j.taskId, {
      decision: "NO_GO",
      reviewer: "claude",
      mustFix: [],
      notes: "fundamentally wrong approach",
    });
    expect(final.state).toBe("rejected");
    expect(isTerminal(final.state)).toBe(true);

    // Subsequent submit attempt should error.
    expect(() => submitIteration(projectRoot, j.taskId, "try again")).toThrow(/Cannot submit/);
  });

  test("invalid transitions: verdict requires review_pending state", () => {
    const j = startTask(projectRoot, "no impl yet");
    // drafting state — can't record verdict.
    expect(() => recordVerdict(projectRoot, j.taskId, {
      decision: "GO",
      reviewer: "claude",
      mustFix: [],
      notes: "",
    })).toThrow(/Cannot record verdict/);

    assignImplementer(projectRoot, j.taskId, "codex");
    // implementing state — still can't record verdict (no submission yet).
    expect(() => recordVerdict(projectRoot, j.taskId, {
      decision: "GO",
      reviewer: "claude",
      mustFix: [],
      notes: "",
    })).toThrow(/Cannot record verdict/);
  });

  test("abandon: terminal, idempotent, clears active pointer", () => {
    const j = startTask(projectRoot, "give up");
    expect(readActiveTaskId(projectRoot)).toBe(j.taskId);

    const abandoned = abandonTask(projectRoot, j.taskId, "scope changed");
    expect(abandoned.state).toBe("abandoned");
    expect(abandoned.abandonReason).toBe("scope changed");
    expect(readActiveTaskId(projectRoot)).toBeNull();

    // Idempotent re-abandon doesn't throw.
    expect(() => abandonTask(projectRoot, j.taskId)).not.toThrow();
  });

  test("disk persistence: read back after write produces identical journal", () => {
    const j1 = startTask(projectRoot, "persist me", { implementer: "claude" });
    assignImplementer(projectRoot, j1.taskId, "claude");
    submitIteration(projectRoot, j1.taskId, "draft v1");
    const read = readJournal(projectRoot, j1.taskId);
    expect(read).not.toBeNull();
    expect(read!.taskId).toBe(j1.taskId);
    expect(read!.state).toBe("review_pending");
    expect(read!.iterations.length).toBe(1);

    // Markdown rendered file exists alongside JSON.
    const mdPath = join(projectRoot, ".agentbridge", "tasks", `${j1.taskId}.md`);
    expect(existsSync(mdPath)).toBe(true);
    const md = readFileSync(mdPath, "utf-8");
    expect(md).toContain("# Task:");
    expect(md).toContain("**State**: review_pending");
    expect(md).toContain("draft v1");
  });

  test("listTaskIds returns sorted ids", () => {
    expect(listTaskIds(projectRoot)).toEqual([]);
    startTask(projectRoot, "task a");
    startTask(projectRoot, "task b");
    const ids = listTaskIds(projectRoot);
    expect(ids.length).toBe(2);
    expect([...ids].sort()).toEqual(ids);  // already sorted
  });

  test("generateTaskId: ascii slug + hex suffix, empty/non-ascii falls back", () => {
    const a = generateTaskId("Implement LRU Cache");
    expect(a).toMatch(/^implement-lru-cache-[0-9a-f]{4}$/);
    const b = generateTaskId("");
    expect(b).toMatch(/^task-[0-9a-f]{4}$/);
    const c = generateTaskId("中文 prompt");
    expect(c).toMatch(/^prompt-[0-9a-f]{4}$/);
  });

  test("isValidTransition: representative cases", () => {
    expect(isValidTransition("drafting", "implementing")).toBe(true);
    expect(isValidTransition("implementing", "review_pending")).toBe(true);
    expect(isValidTransition("review_pending", "iterating")).toBe(true);
    expect(isValidTransition("review_pending", "approved")).toBe(true);
    expect(isValidTransition("iterating", "review_pending")).toBe(true);

    // Forbidden: skip review.
    expect(isValidTransition("implementing", "approved")).toBe(false);
    // Forbidden: terminal → anything.
    expect(isValidTransition("approved", "implementing")).toBe(false);
    expect(isValidTransition("rejected", "review_pending")).toBe(false);
  });

  test("active task pointer survives mid-loop, cleared on abandon", () => {
    const j = startTask(projectRoot, "active test");
    expect(readActiveTaskId(projectRoot)).toBe(j.taskId);
    assignImplementer(projectRoot, j.taskId, "codex");
    submitIteration(projectRoot, j.taskId, "out");
    recordVerdict(projectRoot, j.taskId, {
      decision: "NEED_REVISION",
      reviewer: "claude",
      mustFix: ["x"],
      notes: "",
    });
    // Active pointer still set during iterating.
    expect(readActiveTaskId(projectRoot)).toBe(j.taskId);
    abandonTask(projectRoot, j.taskId);
    expect(readActiveTaskId(projectRoot)).toBeNull();
  });
});
