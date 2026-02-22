import { createContextLogger } from "./logger";

const log = createContextLogger("tmux-view");

/**
 * Represents a tmux pane running an opencode TUI instance
 * connected to a specific debate session.
 */
export interface TmuxPane {
  paneId: string;
  sessionId: string;
}

/**
 * Manages the tmux split-pane layout with live opencode TUI instances
 * for the proposer and critic architects.
 *
 * Each pane runs a real `opencode --session=<id> --model=<model>` process,
 * so the user sees the actual opencode interface — not a log tail.
 */
export interface TmuxDebateView {
  proposer: TmuxPane;
  critic: TmuxPane;
  cleanup: () => Promise<void>;
}

export interface TmuxDebateViewOptions {
  $: any;
  proposerSessionId: string;
  criticSessionId: string;
  proposerModel?: string;
  criticModel?: string;
  serverUrl?: string;
}

/**
 * Build the opencode CLI command for a tmux pane.
 *
 * Uses `--session` to attach to an existing session so the TUI
 * displays the conversation in real time as the SDK prompts it.
 * Passes the server URL via OPENCODE_URL env var so the TUI
 * connects to the existing server instead of starting a new one.
 */
function buildOpencodeCommand(opts: {
  sessionId: string;
  model?: string;
  serverUrl?: string;
}): string {
  const parts: string[] = [];
  // Ensure the TUI instance connects to the running server
  if (opts.serverUrl) {
    parts.push(`OPENCODE_URL=${opts.serverUrl}`);
  }
  parts.push("opencode");
  parts.push(`--session=${opts.sessionId}`);
  if (opts.model) {
    parts.push(`--model=${opts.model}`);
  }
  return parts.join(" ");
}

/**
 * Create a tmux debate view with two panes, each running a live opencode TUI.
 *
 * Layout:
 * ┌──────────────────────┬─────────────────────────┐
 * │  Main opencode       │  opencode TUI           │
 * │  (user's session)    │  Architect-1 (Proposer)  │
 * │                      │  model: claude-opus      │
 * │                      ├─────────────────────────┤
 * │                      │  opencode TUI           │
 * │                      │  Architect-2 (Critic)    │
 * │                      │  model: gemini-2.5-pro   │
 * └──────────────────────┴─────────────────────────┘
 *
 * Returns null if not running inside tmux.
 */
export async function createTmuxDebateView(
  opts: TmuxDebateViewOptions,
): Promise<TmuxDebateView | null> {
  // Log environment state upfront so we can always diagnose failures
  log.info("createTmuxDebateView called", {
    hasTMUX: !!process.env.TMUX,
    TMUX: process.env.TMUX ?? "(unset)",
    TMUX_PANE: process.env.TMUX_PANE ?? "(unset)",
    hasDollarSign: !!opts.$,
    proposerSessionId: opts.proposerSessionId,
    criticSessionId: opts.criticSessionId,
    serverUrl: opts.serverUrl ?? "(unset)",
  });

  if (!process.env.TMUX) {
    log.warn(
      "TMUX env var not set — plugin process is not running inside tmux. " +
      "tmux split-pane view will be skipped. " +
      "Make sure opencode is launched from within a tmux session.",
    );
    return null;
  }

  const { $ } = opts;

  // $TMUX_PANE is set by tmux for every pane and inherited by child processes.
  // Targeting it explicitly ensures panes are always created next to the
  // opencode agent pane, even when the user has switched to a different tab.
  const agentPaneId = process.env.TMUX_PANE;
  if (!agentPaneId) {
    log.warn(
      "TMUX is set but TMUX_PANE is not — cannot determine which pane to split. " +
      "This can happen if the process was spawned outside a normal tmux pane.",
      { TMUX: process.env.TMUX },
    );
    return null;
  }

  try {
    // 1. Split the opencode agent's pane horizontally → right side for proposer
    const pane1Raw = await $`tmux split-window -d -h -p 45 -t ${agentPaneId} -P -F "#{pane_id}"`.text();
    const proposerPaneId = pane1Raw.trim();
    log.debug("Created proposer pane", { paneId: proposerPaneId, agentPaneId });

    // 2. Split proposer pane vertically → bottom-right for critic
    const pane2Raw = await $`tmux split-window -d -v -t ${proposerPaneId} -P -F "#{pane_id}"`.text();
    const criticPaneId = pane2Raw.trim();
    log.debug("Created critic pane", { paneId: criticPaneId });

    // 3. Launch opencode TUI in each pane, connected to their respective sessions
    const proposerCmd = buildOpencodeCommand({
      sessionId: opts.proposerSessionId,
      model: opts.proposerModel,
      serverUrl: opts.serverUrl,
    });

    const criticCmd = buildOpencodeCommand({
      sessionId: opts.criticSessionId,
      model: opts.criticModel,
      serverUrl: opts.serverUrl,
    });

    log.info("Launching opencode TUI in panes", {
      proposer: { paneId: proposerPaneId, cmd: proposerCmd },
      critic: { paneId: criticPaneId, cmd: criticCmd },
    });

    await $`tmux select-pane -T "Architect-1 (Proposer)" -t ${proposerPaneId}`.catch(() => {});
    await $`tmux select-pane -T "Architect-2 (Critic)" -t ${criticPaneId}`.catch(() => {});

    await $`tmux send-keys -t ${proposerPaneId} ${proposerCmd} Enter`;
    await $`tmux send-keys -t ${criticPaneId} ${criticCmd} Enter`;

    return {
      proposer: {
        paneId: proposerPaneId,
        sessionId: opts.proposerSessionId,
      },
      critic: {
        paneId: criticPaneId,
        sessionId: opts.criticSessionId,
      },
      cleanup: async () => {
        try {
          log.debug("Cleaning up tmux panes");
          if (proposerPaneId) {
            await $`tmux send-keys -t ${proposerPaneId} C-c`.catch(() => {});
            // Give opencode a moment to exit gracefully
            await new Promise((r) => setTimeout(r, 500));
            await $`tmux kill-pane -t ${proposerPaneId}`.catch(() => {});
          }
          if (criticPaneId) {
            await $`tmux send-keys -t ${criticPaneId} C-c`.catch(() => {});
            await new Promise((r) => setTimeout(r, 500));
            await $`tmux kill-pane -t ${criticPaneId}`.catch(() => {});
          }
        } catch (e) {
          log.warn("Error during tmux cleanup (non-fatal)", e);
        }
      },
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const errStack = e instanceof Error ? e.stack : undefined;
    log.error("Failed to create tmux debate view", {
      error: errMsg,
      stack: errStack,
      agentPaneId,
      TMUX: process.env.TMUX,
      proposerSessionId: opts.proposerSessionId,
      criticSessionId: opts.criticSessionId,
    });
    return null;
  }
}
