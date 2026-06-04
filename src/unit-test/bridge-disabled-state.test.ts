import { describe, expect, test } from "bun:test";
import { disabledReplyError } from "../bridge-disabled-state";

describe("bridge disabled-state messaging", () => {
  test("kill-disabled sessions explain how to reconnect", () => {
    expect(disabledReplyError("killed")).toContain("disabled by `agentbridge kill`");
    expect(disabledReplyError("killed")).toContain("/resume");
  });

  test("rejected sessions explain another session is active", () => {
    const message = disabledReplyError("rejected");
    expect(message).toContain("rejected this session");
    expect(message).toContain("another Claude Code session is already connected");
    expect(message).toContain("agentbridge kill");
    expect(message).not.toContain("/resume");
  });

  test("missing daemon sessions tell the user to start Codex", () => {
    const message = disabledReplyError("daemon_missing");
    expect(message).toContain("daemon is not running");
    expect(message).toContain("abg codex --via-proxy");
    expect(message).toContain("get_messages");
  });
});
