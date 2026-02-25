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
  test("auto-starts strict budget for explicit numeric duration", async () => {
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

      expect(first.system.join("\n")).toContain("Active Time Budget");
      expect(first.system.join("\n")).not.toContain("Time Budget Confirmation Required");
      expect(first.system.join("\n")).not.toContain("Pending Time Budget Decision");

      const second = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"]?.(
        {
          sessionID: "lead-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        second,
      );

      expect(second.system.join("\n")).toContain("Active Time Budget");
      expect(second.system.join("\n")).not.toContain("Pending Time Budget Decision");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("numeric duration does not require question-tool confirmation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as Record<string, (input: unknown, output: unknown) => Promise<void>>;

      await plugin["chat.message"]?.(
        { sessionID: "lead-session", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "10분 동안 진행해줘" }],
        },
      );

      const output = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"]?.(
        {
          sessionID: "lead-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        output,
      );

      const merged = output.system.join("\n");
      expect(merged).toContain("Active Time Budget");
      expect(merged).not.toContain("MUST ask for an explicit two-option multiple-choice decision via the `question` tool exactly once");
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

  test("allows tool execution when numeric request auto-starts budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as Record<string, (input: unknown, output: unknown) => Promise<void>>;

      await plugin["chat.message"]?.(
        { sessionID: "lead-session", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "10분 동안 리팩토링해줘" }],
        },
      );

      await expect(
        plugin["tool.execute.before"]?.(
          {
            sessionID: "lead-session",
            tool: "bash",
            args: { command: "git status" },
          },
          { args: { command: "git status" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        plugin["tool.execute.before"]?.(
          {
            sessionID: "lead-session",
            tool: "question",
            args: {
              questions: [
                {
                  question: "Choose mode",
                  header: "Time Budget",
                  options: [
                    { label: "Strict", description: "Use strict mode" },
                    { label: "Normal", description: "No strict limit" },
                  ],
                },
              ],
            },
          },
          {
            args: {
              questions: [
                {
                  question: "Choose mode",
                  header: "Time Budget",
                  options: [
                    { label: "Strict", description: "Use strict mode" },
                    { label: "Normal", description: "No strict limit" },
                  ],
                },
              ],
            },
          },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("start_time_budget is not blocked after explicit numeric request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as Record<string, unknown>;
      const hooks = plugin as Record<string, (input: unknown, output: unknown) => Promise<void>>;

      await hooks["chat.message"]?.(
        { sessionID: "lead-session", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "10분 동안 진행해줘" }],
        },
      );

      const transformOut = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]?.(
        {
          sessionID: "lead-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        transformOut,
      );

      const tools = plugin.tool as {
        start_time_budget?: {
          execute: (args: { minutes: number }, toolCtx: { sessionID: string; metadata: (value: unknown) => void }) => Promise<string>;
        };
      };
      expect(tools.start_time_budget).toBeDefined();

      const startedImmediately = await tools.start_time_budget!.execute(
        { minutes: 10 },
        {
          sessionID: "lead-session",
          metadata: () => {},
        },
      );
      expect(startedImmediately).toContain("Time budget started for 10 minute(s)");

      await hooks["chat.message"]?.(
        { sessionID: "lead-session", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "응, 엄격 모드로 진행해줘" }],
        },
      );

      const started = await tools.start_time_budget!.execute(
        { minutes: 10 },
        {
          sessionID: "lead-session",
          metadata: () => {},
        },
      );
      expect(started).toContain("Time budget started for 10 minute(s)");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("decline response disables active strict budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as Record<string, (input: unknown, output: unknown) => Promise<void>>;

      await plugin["chat.message"]?.(
        { sessionID: "lead-session", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "10분 동안 리팩토링해줘" }],
        },
      );

      await expect(
        plugin["tool.execute.before"]?.(
          {
            sessionID: "lead-session",
            tool: "bash",
            args: { command: "git status" },
          },
          { args: { command: "git status" } },
        ),
      ).resolves.toBeUndefined();

      await plugin["chat.message"]?.(
        { sessionID: "lead-session", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "아니, 시간 제한 없이 진행해줘" }],
        },
      );

      await expect(
        plugin["tool.execute.before"]?.(
          {
            sessionID: "lead-session",
            tool: "bash",
            args: { command: "git status" },
          },
          { args: { command: "git status" } },
        ),
      ).resolves.toBeUndefined();

      const output = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"]?.(
        {
          sessionID: "lead-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        output,
      );
      expect(output.system.join("\n")).not.toContain("Active Time Budget");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps active strict budget across session.idle events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as Record<string, (input: unknown, output: unknown) => Promise<void>>;

      await plugin["chat.message"]?.(
        { sessionID: "lead-session", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "10분 동안 진행해줘" }],
        },
      );

      const beforeIdle = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"]?.(
        {
          sessionID: "lead-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        beforeIdle,
      );
      expect(beforeIdle.system.join("\n")).toContain("Active Time Budget");

      await plugin["event"]?.(
        {
          event: {
            type: "session.idle",
            properties: { sessionID: "lead-session" },
          },
        },
        undefined as never,
      );

      const afterIdle = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"]?.(
        {
          sessionID: "lead-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        afterIdle,
      );
      expect(afterIdle.system.join("\n")).toContain("Active Time Budget");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("clears strict budget when session is deleted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as Record<string, (input: unknown, output: unknown) => Promise<void>>;

      await plugin["chat.message"]?.(
        { sessionID: "lead-session", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "10분 동안 진행해줘" }],
        },
      );

      const beforeDelete = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"]?.(
        {
          sessionID: "lead-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        beforeDelete,
      );
      expect(beforeDelete.system.join("\n")).toContain("Active Time Budget");

      await plugin["event"]?.(
        {
          event: {
            type: "session.deleted",
            properties: { info: { id: "lead-session" } },
          },
        },
        undefined as never,
      );

      const afterDelete = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"]?.(
        {
          sessionID: "lead-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        afterDelete,
      );
      expect(afterDelete.system.join("\n")).not.toContain("Active Time Budget");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("throws TIME_BUDGET_EXPIRED once approved window is exhausted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    const originalNow = Date.now;
    try {
      const plugin = (await createPlugin(directory)) as Record<string, (input: unknown, output: unknown) => Promise<void>>;

      await plugin["chat.message"]?.(
        { sessionID: "lead-session", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "1분 동안 진행해줘" }],
        },
      );

      const baseNow = originalNow();
      Date.now = () => baseNow + 61_000;

      await expect(
        plugin["tool.execute.before"]?.(
          {
            sessionID: "lead-session",
            tool: "bash",
            args: { command: "git status" },
          },
          { args: { command: "git status" } },
        ),
      ).rejects.toThrow("TIME_BUDGET_EXPIRED");
    } finally {
      Date.now = originalNow;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps active budget across follow-up lead messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as Record<string, unknown>;
      const hooks = plugin as Record<string, (input: unknown, output: unknown) => Promise<void>>;
      const tools = plugin.tool as {
        start_time_budget?: {
          execute: (args: { minutes: number }, toolCtx: { sessionID: string; metadata: (value: unknown) => void }) => Promise<string>;
        };
      };

      await hooks["chat.message"]?.(
        { sessionID: "lead-session", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "10분 동안 진행해줘" }],
        },
      );

      const preDecision = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]?.(
        {
          sessionID: "lead-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        preDecision,
      );

      await hooks["chat.message"]?.(
        { sessionID: "lead-session", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "응, 엄격 모드로 진행해줘" }],
        },
      );

      const started = await tools.start_time_budget!.execute(
        { minutes: 10 },
        {
          sessionID: "lead-session",
          metadata: () => {},
        },
      );
      expect(started).toContain("Time budget started for 10 minute(s)");

      await hooks["chat.message"]?.(
        { sessionID: "lead-session", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "좋아, 그럼 계속 진행해줘" }],
        },
      );

      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]?.(
        {
          sessionID: "lead-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        output,
      );

      expect(output.system.join("\n")).toContain("Active Time Budget");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("detects numeric intent from input payload when output parts are empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as Record<string, (input: unknown, output: unknown) => Promise<void>>;

      await plugin["chat.message"]?.(
        {
          sessionID: "lead-session",
          agent: "default",
          parts: [{ type: "text", text: "20분 동안 진행해줘" }],
        },
        {
          message: {},
          parts: [],
        },
      );

      const transformOutput = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"]?.(
        {
          sessionID: "lead-session",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        transformOutput,
      );

      expect(transformOutput.system.join("\n")).toContain("Active Time Budget");

      await expect(
        plugin["tool.execute.before"]?.(
          {
            sessionID: "lead-session",
            tool: "bash",
            args: { command: "git status" },
          },
          { args: { command: "git status" } },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("e2e: explicit numeric auto-starts and decline disables strict budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as Record<string, unknown>;
      const hooks = plugin as Record<string, (input: unknown, output: unknown) => Promise<void>>;
      const tools = plugin.tool as {
        start_time_budget?: {
          execute: (args: { minutes: number }, toolCtx: { sessionID: string; metadata: (value: unknown) => void }) => Promise<string>;
        };
      };
      expect(tools.start_time_budget).toBeDefined();

      await hooks["chat.message"]?.(
        {
          sessionID: "s-10",
          agent: "default",
          parts: [{ type: "text", text: "10분 동안 해줘" }],
        },
        { message: {}, parts: [] },
      );

      const confirm10 = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]?.(
        {
          sessionID: "s-10",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        confirm10,
      );
      expect(confirm10.system.join("\n")).toContain("Active Time Budget");

      await expect(
        hooks["tool.execute.before"]?.(
          {
            sessionID: "s-10",
            tool: "bash",
            args: { command: "git status" },
          },
          { args: { command: "git status" } },
        ),
      ).resolves.toBeUndefined();

      await hooks["chat.message"]?.(
        {
          sessionID: "s-20",
          agent: "default",
          parts: [{ type: "text", text: "20분으로 진행해줘" }],
        },
        { message: {}, parts: [] },
      );

      const confirm20 = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]?.(
        {
          sessionID: "s-20",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        confirm20,
      );
      expect(confirm20.system.join("\n")).toContain("Active Time Budget");

      await hooks["chat.message"]?.(
        { sessionID: "s-20", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "응, 엄격 모드로 진행해줘" }],
        },
      );

      const started20 = await tools.start_time_budget!.execute(
        { minutes: 20 },
        {
          sessionID: "s-20",
          metadata: () => {},
        },
      );
      expect(started20).toContain("Time budget started for 20 minute(s)");

      await hooks["chat.message"]?.(
        {
          sessionID: "s-decline",
          agent: "default",
          parts: [{ type: "text", text: "10분 동안 점검해줘" }],
        },
        { message: {}, parts: [] },
      );

      const confirmDecline = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]?.(
        {
          sessionID: "s-decline",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        confirmDecline,
      );
      expect(confirmDecline.system.join("\n")).toContain("Active Time Budget");

      await hooks["chat.message"]?.(
        { sessionID: "s-decline", agent: "default" },
        {
          message: {},
          parts: [{ type: "text", text: "아니, 제한 없이 진행해줘" }],
        },
      );

      await expect(
        hooks["tool.execute.before"]?.(
          {
            sessionID: "s-decline",
            tool: "bash",
            args: { command: "git status" },
          },
          { args: { command: "git status" } },
        ),
      ).resolves.toBeUndefined();

      const postDecline = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]?.(
        {
          sessionID: "s-decline",
          model: { id: "openai/gpt-4o-mini", providerID: "openai", provider: "openai" },
        },
        postDecline,
      );
      expect(postDecline.system.join("\n")).not.toContain("Active Time Budget");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("blocks effective tool outside effective agent mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as Record<string, (input: unknown, output: unknown) => Promise<void>>;

      await plugin["chat.message"]?.(
        { sessionID: "build-session", agent: "build" },
        {
          message: {},
          parts: [{ type: "text", text: "run architecture check" }],
        },
      );

      await expect(
        plugin["tool.execute.before"]?.(
          {
            sessionID: "build-session",
            tool: "effective",
            args: { vision: "check architecture" },
          },
          { args: { vision: "check architecture" } },
        ),
      ).rejects.toThrow("EFFECTIVE_TOOL_RESTRICTED");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("allows effective tool in effective agent mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as Record<string, (input: unknown, output: unknown) => Promise<void>>;

      await plugin["chat.message"]?.(
        { sessionID: "effective-session", agent: "effective" },
        {
          message: {},
          parts: [{ type: "text", text: "use effective tool" }],
        },
      );

      await expect(
        plugin["tool.execute.before"]?.(
          {
            sessionID: "effective-session",
            tool: "effective",
            args: { vision: "check architecture" },
          },
          { args: { vision: "check architecture" } },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("injects effective and architect agents when missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effective-opencode-index-test-"));
    try {
      const plugin = (await createPlugin(directory)) as {
        config?: (input: unknown) => Promise<void>;
      };

      const appConfig: Record<string, unknown> = {};
      await plugin.config?.(appConfig);

      const agents = appConfig.agent as Record<string, unknown>;
      const effective = agents.effective as Record<string, unknown>;
      const architect = agents.architect as Record<string, unknown>;

      expect(effective).toBeDefined();
      expect(effective.mode).toBe("primary");
      expect(architect).toBeDefined();
      expect(architect.mode).toBe("subagent");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
