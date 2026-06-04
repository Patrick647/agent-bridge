/**
 * Unit tests for log-writer rotation (2026-05-18 P2).
 *
 * These tests have to run BEFORE log-writer is otherwise imported in
 * the suite, because rotation knobs are captured at module load from
 * env. We set tiny thresholds so a few write() calls trigger
 * rotation; in production the defaults are 50 MB and 5 backups.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { getAsyncFileLogger, closeAllAsyncFileLoggers, _testingState, _testingSetConstants } = await import("../log-writer");
// Force tiny thresholds for tests. Done via setter (not env) because
// Bun shares module cache across test files; another test importing
// log-writer first would lock the constants to defaults.
_testingSetConstants({ maxSize: 200, backups: 3 });

describe("log-writer rotation", () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "abg-log-rotate-test-"));
    logPath = join(tempDir, "test.log");
  });

  afterEach(async () => {
    await closeAllAsyncFileLoggers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("constants captured from env", () => {
    const state = _testingState();
    expect(state.LOG_MAX_SIZE_BYTES).toBe(200);
    expect(state.LOG_BACKUPS).toBe(3);
  });

  test("writes a single line that fits below threshold — no rotation", async () => {
    const logger = getAsyncFileLogger(logPath);
    logger.write("hello world\n");
    await new Promise((r) => setTimeout(r, 50));  // flush

    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf-8")).toBe("hello world\n");
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  test("rotates when next write would cross threshold", async () => {
    const logger = getAsyncFileLogger(logPath);
    // First write — ~150 bytes, below 200 threshold.
    logger.write("a".repeat(150) + "\n");
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(`${logPath}.1`)).toBe(false);

    // Second write — pushes total above 200, triggers rotation BEFORE
    // the write. So .log.1 has the FIRST line, .log has the new line.
    logger.write("b".repeat(100) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(readFileSync(`${logPath}.1`, "utf-8")).toContain("a".repeat(150));
    expect(readFileSync(logPath, "utf-8")).toContain("b".repeat(100));
  });

  test("shifts backups on second rotation: .1 → .2", async () => {
    const logger = getAsyncFileLogger(logPath);

    logger.write("FIRST" + "a".repeat(195) + "\n");   // crosses threshold next
    await new Promise((r) => setTimeout(r, 30));
    logger.write("SECOND" + "b".repeat(195) + "\n");  // rotation happens HERE
    await new Promise((r) => setTimeout(r, 30));
    logger.write("THIRD" + "c".repeat(195) + "\n");   // rotation again
    await new Promise((r) => setTimeout(r, 50));

    // Current .log has THIRD; .1 has SECOND; .2 has FIRST.
    expect(readFileSync(logPath, "utf-8")).toContain("THIRD");
    expect(readFileSync(`${logPath}.1`, "utf-8")).toContain("SECOND");
    expect(readFileSync(`${logPath}.2`, "utf-8")).toContain("FIRST");
  });

  test("drops oldest backup beyond LOG_BACKUPS limit (=3)", async () => {
    const logger = getAsyncFileLogger(logPath);

    // 5 large writes — each triggers a rotation. With LOG_BACKUPS=3,
    // we keep .log + .log.1 + .log.2 + .log.3 = 4 files; older drops.
    for (let i = 1; i <= 5; i++) {
      logger.write(`ROUND${i}` + "x".repeat(200) + "\n");
      await new Promise((r) => setTimeout(r, 30));
    }

    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(true);
    expect(existsSync(`${logPath}.3`)).toBe(true);
    expect(existsSync(`${logPath}.4`)).toBe(false);  // dropped
    expect(existsSync(`${logPath}.5`)).toBe(false);

    // Newest goes to .log, oldest kept goes to .log.3.
    expect(readFileSync(logPath, "utf-8")).toContain("ROUND5");
    expect(readFileSync(`${logPath}.3`, "utf-8")).toContain("ROUND2");
    // ROUND1 was dropped (would have been .4).
  });

  test("bootstraps counter from existing file size", async () => {
    // Pre-create a log file just below threshold.
    writeFileSync(logPath, "x".repeat(180), "utf-8");

    const logger = getAsyncFileLogger(logPath);
    // First write — only 30 bytes, but total 180+30 = 210 > 200,
    // should trigger rotation.
    logger.write("y".repeat(28) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    expect(existsSync(`${logPath}.1`)).toBe(true);
    // .log.1 has the pre-existing content (the 180 x's).
    expect(readFileSync(`${logPath}.1`, "utf-8")).toContain("x".repeat(180));
    // .log has the new content.
    expect(readFileSync(logPath, "utf-8")).toContain("y".repeat(28));
  });
});
