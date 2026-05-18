import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeCollaborationSections } from "../cli/init";
import {
  MARKER_ID,
  getWorkflowSections,
  isValidWorkflowPreset,
  VALID_WORKFLOW_PRESETS,
} from "../collaboration-content";

const START = `<!-- ${MARKER_ID}:start -->`;
const END = `<!-- ${MARKER_ID}:end -->`;

describe("writeCollaborationSections", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-collab-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates CLAUDE.md and AGENTS.md when they don't exist", () => {
    const results = writeCollaborationSections(tempDir);

    expect(results).toHaveLength(2);
    expect(results[0]).toContain("CLAUDE.md: created");
    expect(results[1]).toContain("AGENTS.md: created");

    const claude = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(claude).toContain(START);
    expect(claude).toContain(END);
    expect(claude).toContain("Multi-Agent Collaboration");
    expect(claude).toContain("Codex");

    const agents = readFileSync(join(tempDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain(START);
    expect(agents).toContain(END);
    expect(agents).toContain("Multi-Agent Collaboration");
    expect(agents).toContain("Claude");
  });

  test("appends to existing CLAUDE.md without markers", () => {
    const existingContent = "# My Project Rules\n\nDo not break things.\n";
    writeFileSync(join(tempDir, "CLAUDE.md"), existingContent, "utf-8");

    const results = writeCollaborationSections(tempDir);

    expect(results[0]).toContain("CLAUDE.md: appended");

    const claude = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    // Original content preserved
    expect(claude).toContain("# My Project Rules");
    expect(claude).toContain("Do not break things.");
    // New section appended
    expect(claude).toContain(START);
    expect(claude).toContain("Multi-Agent Collaboration");
  });

  test("replaces existing markers on re-run", () => {
    // First run
    writeCollaborationSections(tempDir);
    const firstRun = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(firstRun).toContain(START);

    // Second run (idempotent replace)
    const results = writeCollaborationSections(tempDir);
    expect(results[0]).toContain("unchanged");

    const secondRun = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(secondRun).toBe(firstRun);
  });

  test("preserves pre-existing content when appending", () => {
    const projectRules = [
      "# Project CLAUDE.md",
      "",
      "## Git Rules",
      "- Always use feature branches",
      "- Squash merge only",
      "",
    ].join("\n");
    writeFileSync(join(tempDir, "CLAUDE.md"), projectRules, "utf-8");

    writeCollaborationSections(tempDir);

    const result = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    // All original content preserved
    expect(result).toContain("# Project CLAUDE.md");
    expect(result).toContain("## Git Rules");
    expect(result).toContain("Always use feature branches");
    expect(result).toContain("Squash merge only");
    // Collaboration section added
    expect(result).toContain("Multi-Agent Collaboration");
  });

  test("skips malformed file instead of corrupting it", () => {
    // User's CLAUDE.md has an orphan start marker (end deleted manually).
    // upsertMarkedSection throws; init should skip just this file and keep going.
    const orphaned = `# My Project\n<!-- ${MARKER_ID}:start -->\nLegacy notes preserved here\n## Other Section\nImportant user content\n`;
    writeFileSync(join(tempDir, "CLAUDE.md"), orphaned, "utf-8");

    const results = writeCollaborationSections(tempDir);

    expect(results[0]).toContain("CLAUDE.md: skipped");
    expect(results[0]).toContain("Malformed");
    // AGENTS.md didn't exist → should still be created.
    expect(results[1]).toContain("AGENTS.md: created");

    // Critically: CLAUDE.md content is untouched.
    const unchanged = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(unchanged).toBe(orphaned);
  });

  test("updates when section content changes between versions", () => {
    // Simulate an older version's markers with different content
    const oldContent = `# Project\n\n${START}\nOLD COLLABORATION CONTENT\n${END}\n`;
    writeFileSync(join(tempDir, "CLAUDE.md"), oldContent, "utf-8");

    const results = writeCollaborationSections(tempDir);
    expect(results[0]).toContain("CLAUDE.md: updated");

    const updated = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(updated).not.toContain("OLD COLLABORATION CONTENT");
    expect(updated).toContain("Multi-Agent Collaboration");
    expect(updated).toContain("# Project");
  });
});

// ── Workflow preset support (2026-05-18) ────────────────────────────

describe("workflow preset registry", () => {
  test("VALID_WORKFLOW_PRESETS includes default + codex-implements", () => {
    expect(VALID_WORKFLOW_PRESETS).toContain("default");
    expect(VALID_WORKFLOW_PRESETS).toContain("codex-implements");
  });

  test("isValidWorkflowPreset accepts known + rejects unknown", () => {
    expect(isValidWorkflowPreset("default")).toBe(true);
    expect(isValidWorkflowPreset("codex-implements")).toBe(true);
    expect(isValidWorkflowPreset("bogus")).toBe(false);
    expect(isValidWorkflowPreset("")).toBe(false);
  });

  test("getWorkflowSections('default') returns the generic content", () => {
    const sections = getWorkflowSections("default");
    expect(sections.claudeMd).toContain("Multi-Agent Collaboration");
    expect(sections.agentsMd).toContain("Multi-Agent Collaboration");
    // Generic content does NOT name the codex-implements preset.
    expect(sections.claudeMd).not.toContain("codex-implements preset");
    expect(sections.agentsMd).not.toContain("codex-implements preset");
  });

  test("getWorkflowSections('codex-implements') returns the preset content", () => {
    const sections = getWorkflowSections("codex-implements");
    // Both files self-identify as the preset.
    expect(sections.claudeMd).toContain("codex-implements preset");
    expect(sections.agentsMd).toContain("codex-implements preset");
    // Claude side documents Claude's roles.
    expect(sections.claudeMd).toContain("Reviewer / Planner / Git operator");
    expect(sections.claudeMd).toContain("All git operations");
    // Agents side documents Codex's roles.
    expect(sections.agentsMd).toContain("Implementer / Executor / Verifier");
    expect(sections.agentsMd).toContain("Stop at git boundary");
  });
});

describe("writeCollaborationSections with --workflow codex-implements", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-collab-preset-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("writes codex-implements preset content when requested", () => {
    const results = writeCollaborationSections(tempDir, "codex-implements");

    expect(results).toHaveLength(2);

    const claude = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    const agents = readFileSync(join(tempDir, "AGENTS.md"), "utf-8");

    expect(claude).toContain(START);
    expect(claude).toContain(END);
    expect(claude).toContain("codex-implements preset");
    expect(claude).toContain("Reviewer / Planner / Git operator");

    expect(agents).toContain(START);
    expect(agents).toContain(END);
    expect(agents).toContain("codex-implements preset");
    expect(agents).toContain("Implementer / Executor / Verifier");
  });

  test("re-running with default preset overwrites codex-implements content", () => {
    // First write — codex-implements content.
    writeCollaborationSections(tempDir, "codex-implements");
    const first = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(first).toContain("codex-implements preset");

    // Second write — default. Should replace inside the markers.
    writeCollaborationSections(tempDir, "default");
    const second = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(second).not.toContain("codex-implements preset");
    expect(second).toContain("Multi-Agent Collaboration");
  });

  test("default preset behavior is preserved when workflow arg omitted", () => {
    // Backward compat: writeCollaborationSections(dir) with no second
    // arg must produce the same content as default preset.
    const sectionsDefault = getWorkflowSections("default");
    writeCollaborationSections(tempDir);
    const claude = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    // Strip the marker frame to compare just the body.
    const startIdx = claude.indexOf(START) + START.length;
    const endIdx = claude.indexOf(END);
    const body = claude.slice(startIdx, endIdx).trim();
    expect(body).toBe(sectionsDefault.claudeMd.trim());
  });
});
