import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EffectiveOpencodePlugin from "../index";

const createPlugin = async (directory: string) => {
  const plugin = await EffectiveOpencodePlugin({
    directory,
    client: {
      session: {
        abort: async () => ({ data: true }),
        command: async () => ({ data: true }),
      },
      tui: {
        showToast: async () => ({ data: true }),
      },
    },
  } as never);

  return plugin;
};

describe("time budget prompt scope", () => {
  test("asks lead once, then keeps pending decision reminder", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as Record<string, (input: unknown, output: unknown) => Promise<void>>;

      await plugin["chat.message"]?.(
        { sessionID: "lead-session", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "10분 동안 검토해줘" }],
        },
      );

      const first = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"]?.(
        {
          sessionID: "lead-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        first,
      );

      expect(first.system.join("\n")).toContain("Time Budget Confirmation Required");
      expect(first.system.join("\n")).toContain("Pending Time Budget Decision");

      const second = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"]?.(
        {
          sessionID: "lead-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        second,
      );

      expect(second.system.join("\n")).not.toContain("Time Budget Confirmation Required");
      expect(second.system.join("\n")).toContain("Pending Time Budget Decision");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not ask subagent sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as Record<string, (input: unknown, output: unknown) => Promise<void>>;

      await plugin["chat.message"]?.(
        { sessionID: "subagent-session", agent: "architect" },
        {
          message: {},
          parts: [{ type: "text", text: "10분 안에 끝내줘" }],
        },
      );

      const output = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"]?.(
        {
          sessionID: "subagent-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        output,
      );

      expect(output.system.join("\n")).not.toContain("Time Budget Confirmation Required");
      expect(output.system.join("\n")).not.toContain("Pending Time Budget Decision");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
