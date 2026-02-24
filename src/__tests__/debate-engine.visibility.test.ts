import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDebate } from "../debate-engine";

import { DEFAULT_CONFIG } from "../types";
import type { DebateVisibilityEvent, DialogueRound, OpencodeClient, PluginConfig } from "../types";

type MockShell = {
  (strings: TemplateStringsArray, ...values: Array<unknown>): {
    text: () => Promise<string>;
    catch: (onRejected: (error: unknown) => unknown) => Promise<string>;
  };
};

type SessionCreateBody = {
  parentID?: string;
  title?: string;
  permission?: Array<{ permission?: unknown }>;
};

type MockSessionState = {
  role: "proposer" | "critic";
  calls: number;
  messages: AssistantMessage[];
};

type AssistantMessage = {
  id: string;
  info: {
    id: string;
    role: string;
    time: { created: number; completed: number };
  };
  parts?: Array<{ type: string; text: string }>;
};

const mkShell = (): MockShell => {
  return (strings: TemplateStringsArray, ...values: Array<unknown>) => {
    const command = strings.reduce(
      (acc, str, index) => `${acc}${str}${index < values.length ? String(values[index]) : ""}`,
      "",
    );
    const text = async () => {
      if (command.trim().startsWith("mkdir -p ")) {
        const dir = command.replace(/^mkdir -p /, "").trim();
        await mkdir(dir, { recursive: true });
      }
      return "";
    };
    const commandResult = Promise.resolve("");
    return {
      text,
      catch: () => commandResult,
    };
  };
};

const createMockDebateClient = (responses: {
  proposer: string[];
  critic: string[];
  onCreate?: (body: SessionCreateBody) => void;
}): OpencodeClient => {
  const sessions = new Map<string, MockSessionState>();
  let nextSessionId = 0;

  const createMessage = (
    text: string,
  ): { id: string; info: AssistantMessage["info"]; parts: AssistantMessage["parts"] } => {
    const now = Date.now();
    const id = `msg-${now}-${Math.random().toString(36).slice(2)}`;
    return {
      id,
      info: {
        id,
        role: "assistant",
        time: {
          created: now,
          completed: now + 1,
        },
      },
      parts: [{ type: "text", text }],
    };
  };

  const getNextResponse = (sessionId: string, text: string): string => {
    const state = sessions.get(sessionId);
    if (!state) return text;

    const scripted = state.role === "proposer" ? responses.proposer : responses.critic;
    const response = scripted[state.calls] ?? text;
    state.calls += 1;
    return response;
  };

  return {
    session: {
      create: async ({ body }: { body?: { title?: string } }) => {
        const id = `session-${++nextSessionId}`;
        const title = body?.title ?? "";
        responses.onCreate?.(body as SessionCreateBody);
        const role = title.includes("Architect-1") ? "proposer" : "critic";
        sessions.set(id, { role, calls: 0, messages: [] });
        return { data: { id } };
      },

      promptAsync: async ({
        path,
        body,
      }: { path?: { id?: string }; body?: { parts?: Array<{ text?: string; type?: string }> } }) => {
        const sessionId = path?.id as string;
        const state = sessions.get(sessionId);
        if (!state) throw new Error(`Unknown session: ${sessionId}`);
        const text = body?.parts?.[0]?.text ?? "";
        const response = getNextResponse(sessionId, text);
        const message = createMessage(response);
        state.messages.push(message);
        return { data: { id: message.id } };
      },

      messages: async ({ path }: { path?: { id?: string } }) => {
        const sessionId = path?.id as string;
        const state = sessions.get(sessionId);
        if (!state) return { data: [] };
        return {
          data: state.messages.map((message) => ({
            ...message,
            completed: message.info.time.completed,
          })),
        };
      },

      prompt: async ({ path, body }: { path?: { id?: string }; body?: { parts?: Array<{ text?: string; type?: string }> } }) => {
        const sessionId = path?.id as string;
        const state = sessions.get(sessionId);
        if (!state) throw new Error(`Unknown session: ${sessionId}`);
        const text = body?.parts?.[0]?.text ?? "";
        const response = getNextResponse(sessionId, text);
        const message = createMessage(response);
        state.messages.push(message);
        return {
          data: {
            id: message.id,
            parts: message.parts,
            info: message.info,
          },
        };
      },

      message: async ({ path }: { path?: { id?: string; messageID?: string } }) => {
        const sessionId = path?.id as string;
        const messageID = path?.messageID as string;
        const state = sessions.get(sessionId);
        const message = state?.messages.find((m) => m.id === messageID);
        if (!message) return {};
        return { data: message };
      },

      delete: async () => {
        return { data: true };
      },

      abort: async () => {
        return { data: true };
      },
    },
  } as unknown as OpencodeClient;
};

const mkWorkingDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "effective-opencode-debate-"));
  await mkdir(`${dir}/.opencode`, { recursive: true });
  return dir;
};

describe("debate-engine visibility callbacks", () => {
  const tempDirs: string[] = [];
  const originalEnv = {
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
  };
  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    maxRounds: 1,
  };

  const assertCreatePermissions = async (toolCtx: {
    title: string;
    verdict: string;
    proposal: string;
  }) => {
    const calls: SessionCreateBody[] = [];
    const client = createMockDebateClient({
      proposer: [toolCtx.proposal],
      critic: ["Prep notes", toolCtx.verdict],
      onCreate: (body) => {
        calls.push(body);
      },
    });

    const directory = await mkWorkingDir();
    tempDirs.push(directory);

    const result = await runDebate(client, {
      directory,
      $: mkShell() as unknown as never,
    }, {
      parentSessionID: "parent",
      vision: toolCtx.title,
      projectContext: "Project context",
      config,
      abort: new AbortController().signal,
      architectSessions: new Set(),
      onRound: () => {},
    });

    expect(result.consensus).toBe(true);
    expect(calls).toHaveLength(2);
    return calls;
  };

  const verdict = "```json:verdict\n{" +
    '"approved": true, "score": 8, "key_issues": []' +
    "}\n```";
  const rejectedVerdict = "```json:verdict\n{" +
    '"approved": false, "score": 4, "key_issues": ["Needs work"]' +
    "}\n```";

  afterEach(async () => {
    process.env.TMUX = originalEnv.TMUX;
    process.env.TMUX_PANE = originalEnv.TMUX_PANE;
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
    );
    tempDirs.length = 0;
  });

  beforeEach(() => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });

  test("uses onVisibility and ignores onStatus when both exist", async () => {
    const client = createMockDebateClient({
      proposer: ["Initial proposal draft"],
      critic: ["Prep notes", verdict],
    });
    const directory = await mkWorkingDir();
    tempDirs.push(directory);

    const visibilityEvents: Array<{ kind: string; message: string; round?: number }> = [];
    const statusEvents: string[] = [];
    const rounds: DialogueRound[] = [];
    const onVisibility = (event: DebateVisibilityEvent) => {
      visibilityEvents.push({ kind: event.kind, message: event.message, round: event.round });
    };

    const result = await runDebate(client, {
      directory,
      $: mkShell() as unknown as never,
    }, {
      parentSessionID: "parent",
      vision: "Design a resilient event stream",
      projectContext: "Project context",
      config,
      abort: new AbortController().signal,
      architectSessions: new Set(),
      onRound: (round) => {
        rounds.push(round);
      },
      onVisibility,
      onStatus: (status) => {
        statusEvents.push(status);
      },
      serverUrl: undefined,
    });

    expect(result.consensus).toBe(true);
    expect(rounds).toHaveLength(1);
    expect(visibilityEvents.length).toBeGreaterThan(0);
    expect(visibilityEvents.some((event) => event.kind === "consensus")).toBe(true);
    expect(statusEvents).toHaveLength(0);
  });

  test("emits one terminal event on successful debate completion", async () => {
    const client = createMockDebateClient({
      proposer: ["Initial proposal draft"],
      critic: ["Prep notes", verdict],
    });
    const directory = await mkWorkingDir();
    tempDirs.push(directory);

    const terminalMessages: string[] = [];

    const result = await runDebate(client, {
      directory,
      $: mkShell() as unknown as never,
    }, {
      parentSessionID: "parent",
      vision: "Detect terminal emission",
      projectContext: "Project context",
      config,
      abort: new AbortController().signal,
      architectSessions: new Set(),
      onRound: () => {},
      onVisibility: (event) => {
        if (
          event.kind === "consensus" &&
          event.message === "Round 1: Consensus reached!"
        ) {
          terminalMessages.push(event.message);
        }
      },
    });

    expect(result.consensus).toBe(true);
    expect(terminalMessages).toEqual(["Round 1: Consensus reached!"]);
  });

  test("emits one terminal event when max rounds are reached", async () => {
    const client = createMockDebateClient({
      proposer: ["Initial proposal draft"],
      critic: ["Prep notes", rejectedVerdict],
    });
    const directory = await mkWorkingDir();
    tempDirs.push(directory);

    const terminalMessages: string[] = [];

    const result = await runDebate(client, {
      directory,
      $: mkShell() as unknown as never,
    }, {
      parentSessionID: "parent",
      vision: "Hit max rounds",
      projectContext: "Project context",
      config,
      abort: new AbortController().signal,
      architectSessions: new Set(),
      onRound: () => {},
      onVisibility: (event) => {
        if (event.kind === "complete" && event.message === "Max rounds reached without full consensus") {
          terminalMessages.push(event.message);
        }
      },
    });

    expect(result.consensus).toBe(false);
    expect(result.rounds).toHaveLength(1);
    expect(terminalMessages).toEqual(["Max rounds reached without full consensus"]);
  });

  test("falls back to onStatus when onVisibility is missing", async () => {
    const client = createMockDebateClient({
      proposer: ["Another proposal draft"],
      critic: ["More notes", verdict],
    });
    const directory = await mkWorkingDir();
    tempDirs.push(directory);
    const statusEvents: string[] = [];

    const result = await runDebate(client, {
      directory,
      $: mkShell() as unknown as never,
    }, {
      parentSessionID: "parent",
      vision: "Design fallback behavior",
      projectContext: "Project context",
      config,
      abort: new AbortController().signal,
      architectSessions: new Set(),
      onRound: () => {},
      onStatus: (status) => {
        statusEvents.push(status);
      },
      onVisibility: undefined,
    });

    expect(result.rounds).toHaveLength(1);
    expect(statusEvents.length).toBeGreaterThan(0);
    expect(result.consensus).toBe(true);
  });

  test("survives failing onVisibility callbacks", async () => {
    const client = createMockDebateClient({
      proposer: ["Resilient proposal"],
      critic: ["Prep notes", verdict],
    });
    const directory = await mkWorkingDir();
    tempDirs.push(directory);
    let callbackCount = 0;

    const result = await runDebate(client, {
      directory,
      $: mkShell() as unknown as never,
    }, {
      parentSessionID: "parent",
      vision: "Handle failing callbacks",
      projectContext: "Project context",
      config,
      abort: new AbortController().signal,
      architectSessions: new Set(),
      onRound: () => {},
      onVisibility: () => {
        callbackCount += 1;
        throw new Error("visibility failure");
      },
    });

    expect(result.consensus).toBe(true);
    expect(callbackCount).toBeGreaterThan(0);
  });

  test("creates sub-sessions with read/edit/write permissions", async () => {
    const calls = await assertCreatePermissions({
      title: "Enable subagent file editing",
      verdict,
      proposal: "Initial proposal draft",
    });

    for (const call of calls) {
      const perms = call.permission ?? [];
      const enabled = perms
        .map((entry) => typeof entry.permission === "string" ? entry.permission : "")
        .filter(Boolean);
      expect(enabled).toContain("read");
      expect(enabled).toContain("edit");
      expect(enabled).toContain("write");
    }
  });

  test("registers architect sessions through callback and cleans compatibility set", async () => {
    const client = createMockDebateClient({
      proposer: ["Initial proposal draft"],
      critic: ["Prep notes", verdict],
    });
    const directory = await mkWorkingDir();
    tempDirs.push(directory);

    const architectSessions = new Set<string>();
    const callbacks: Array<{ role: "proposer" | "critic"; sessionID: string }> = [];

    const result = await runDebate(client, {
      directory,
      $: mkShell() as unknown as never,
    }, {
      parentSessionID: "parent",
      vision: "Register sub-sessions through callback",
      projectContext: "Project context",
      config,
      abort: new AbortController().signal,
      architectSessions,
      onRound: () => {},
      onSessionCreated: (sessionID, role) => {
        callbacks.push({ role, sessionID });
        return { ok: true };
      },
    });

    expect(result.consensus).toBe(true);
    expect(callbacks).toHaveLength(2);
    expect(callbacks.map((entry) => entry.role).sort()).toEqual(["critic", "proposer"]);
    expect(architectSessions.size).toBe(0);
  });

  test("fails fast when callback rejects a session attachment", async () => {
    const client = createMockDebateClient({
      proposer: ["Initial proposal draft"],
      critic: ["Prep notes", verdict],
    });
    const directory = await mkWorkingDir();
    tempDirs.push(directory);

    const architectSessions = new Set<string>();
    const run = runDebate(client, {
      directory,
      $: mkShell() as unknown as never,
    }, {
      parentSessionID: "parent",
      vision: "Reject attachment for a child session",
      projectContext: "Project context",
      config,
      abort: new AbortController().signal,
      architectSessions,
      onRound: () => {},
      onSessionCreated: (_, role) => {
        if (role === "critic") return { ok: false, reason: "duplicate-session" };
        return { ok: true };
      },
    });

    await expect(run).rejects.toThrow(/Failed to bind critic session/);
    expect(architectSessions.size).toBe(0);
  });
});
