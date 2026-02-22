import { describe, expect, test } from "bun:test";
import { shouldInvalidateContextCacheFromToolEvent } from "../context/mutation-policy";

describe("context.mutation-policy", () => {
  test("does not invalidate cache for read-only tools", () => {
    const decision = shouldInvalidateContextCacheFromToolEvent({
      type: "tool.execute.after",
      payload: {
        tool: "read",
        args: {
          filePath: "src/index.ts",
        },
      },
    });

    expect(decision.mutate).toBe(false);
    expect(decision.reason).toBe("readonly-tool:read");
  });

  test("invalidates cache for known mutating tools", () => {
    const decision = shouldInvalidateContextCacheFromToolEvent({
      type: "tool.execute.after",
      payload: {
        tool: "write",
        args: {
          filePath: "src/index.ts",
        },
      },
    });

    expect(decision.mutate).toBe(true);
    expect(decision.reason).toBe("mutating-tool:write");
  });

  test("invalidates cache for unknown tools conservatively", () => {
    const decision = shouldInvalidateContextCacheFromToolEvent({
      type: "tool.execute.after",
      payload: {
        tool: "unknown_tool",
      },
    });

    expect(decision.mutate).toBe(true);
    expect(decision.reason).toBe("unknown-tool:unknown_tool");
  });

  test("does not invalidate for bash read-only command", () => {
    const decision = shouldInvalidateContextCacheFromToolEvent({
      type: "tool.execute.after",
      payload: {
        tool: "bash",
        args: {
          command: 'bash -lc "ls -la /tmp"',
        },
      },
    });

    expect(decision.mutate).toBe(false);
    expect(decision.reason).toBe("shell-ls-read-only");
  });

  test("invalidates for bash write command", () => {
    const decision = shouldInvalidateContextCacheFromToolEvent({
      type: "tool.execute.after",
      payload: {
        tool: "bash",
        args: {
          command: 'bash -lc "cat > /tmp/out.txt"',
        },
      },
    });

    expect(decision.mutate).toBe(true);
    expect(decision.reason).toBe("shell-redirection");
  });
});
