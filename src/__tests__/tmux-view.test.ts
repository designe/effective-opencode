import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTmuxDebateView } from "../tmux-view";

function renderCommand(strings: TemplateStringsArray, values: unknown[]): string {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += String(values[i]);
  }
  return out;
}

describe("createTmuxDebateView", () => {
  const originalTMUX = process.env.TMUX;
  const originalTMUXPane = process.env.TMUX_PANE;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.TMUX = "/tmp/tmux-1000/default,123,0";
    process.env.TMUX_PANE = "%0";
  });

  afterEach(() => {
    if (originalTMUX === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTMUX;

    if (originalTMUXPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = originalTMUXPane;

    globalThis.fetch = originalFetch;
  });

  test("falls back to local session mode when server URL is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("unreachable");
    }) as unknown as typeof fetch;

    const commands: string[] = [];
    const $ = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const command = renderCommand(strings, values);
      commands.push(command);

      if (command.includes("split-window")) {
        return { text: async () => "%1" };
      }
      return Promise.resolve("");
    }) as unknown;

    const view = await createTmuxDebateView({
      $,
      proposerSessionId: "proposer-session",
      criticSessionId: "critic-session",
      serverUrl: "http://127.0.0.1:9999",
      createCriticPane: false,
    });

    expect(view).not.toBeNull();
    const sendKeys = commands.find((c) => c.includes("tmux send-keys")) ?? "";
    expect(sendKeys.includes("opencode attach")).toBe(false);
    expect(sendKeys.includes("--session='proposer-session'")).toBe(true);
  });

  test("uses attach mode when server URL is reachable", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const commands: string[] = [];
    const $ = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const command = renderCommand(strings, values);
      commands.push(command);

      if (command.includes("split-window")) {
        return { text: async () => "%1" };
      }
      return Promise.resolve("");
    }) as unknown;

    const view = await createTmuxDebateView({
      $,
      proposerSessionId: "proposer-session",
      criticSessionId: "critic-session",
      serverUrl: "http://127.0.0.1:4096",
      createCriticPane: false,
    });

    expect(view).not.toBeNull();
    const sendKeys = commands.find((c) => c.includes("tmux send-keys")) ?? "";
    expect(sendKeys.includes("opencode attach")).toBe(true);
  });
});
