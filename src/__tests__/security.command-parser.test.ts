import { describe, expect, test } from "bun:test";
import { parseBashCommand, tokenizeShellCommand } from "../security/command-parser";

describe("command-parser", () => {
  test("tokenizeShellCommand handles quoted arguments", () => {
    const tokens = tokenizeShellCommand('echo "hello world" file\\ name.txt');

    expect(tokens).toEqual(["echo", "hello world", "file name.txt"]);
  });

  test("parseBashCommand splits command and args", () => {
    const parsed = parseBashCommand('bash -lc "ls -la"');

    expect(parsed).toEqual({
      command: "bash",
      args: ["-lc", "ls -la"],
    });
  });

  test("parseBashCommand handles mixed single and double quotes", () => {
    const parsed = parseBashCommand("echo 'alpha beta' \"gamma delta\"");

    expect(parsed).toEqual({
      command: "echo",
      args: ["alpha beta", "gamma delta"],
    });
  });

  test("parseBashCommand returns null for empty input", () => {
    const parsed = parseBashCommand("   ");

    expect(parsed).toBeNull();
  });
});
