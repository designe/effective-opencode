import { parseVerdict, detectConsensus } from "./consensus";
import {
  type PluginConfig,
  type PluginInput,
  type ProtocolResult,
  type DebateVisibilityEvent,
  type DebateAgent,
  type DialogueRound,
  type OpencodeClient,
  type ModelConfig,
  parseModelString,
  FALLBACK_MODELS,
} from "./types";
import { createContextLogger } from "./logger";
import { createTmuxDebateView, type TmuxDebateView } from "./tmux-view";
import {
  PROPOSER_PERSONA,
  CRITIC_PERSONA,
  buildInitialProposerPrompt,
  buildInitialCritiquePrompt,
  buildCriticPreparationPrompt,
  buildCritiquePrompt,
  buildRevisionPrompt,
  formatFullTranscript,
} from "./prompts";

const log = createContextLogger("debate-engine");

export interface DebateInput {
  parentSessionID: string;
  vision: string;
  projectContext: string;
  config: PluginConfig;
  abort: AbortSignal;
  onRound: (round: DialogueRound) => void;
  /** Called when an architect starts or finishes a thinking step */
  onStatus?: (status: string) => void;
  /** Preferred structured event stream for visibility updates */
  onVisibility?: (event: DebateVisibilityEvent) => void | Promise<void>;
  /** URL of the running opencode server (for TUI connection) */
  serverUrl?: string;
  /**
   * Shared set of active architect session IDs.
   * The plugin's permission.ask hook uses this to auto-approve tool calls
   * from architect sessions (so they don't hang waiting for human approval).
   */
  architectSessions?: Set<string>;
}

type PromptPart = { type?: string; text?: string };
type PromptResponsePayload = {
  info?: { id?: string; error?: unknown };
  parts?: PromptPart[];
};

function isModelUnsafeForArchitect(model?: string): boolean {
  if (!model) return false;
  const normalized = model.toLowerCase();
  // Known unstable path for this plugin's synchronous prompt flow.
  if (normalized.includes("glm-5-free")) return true;
  return false;
}

function serializeUnknown(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTextFromParts(parts: PromptPart[] | undefined): string {
  if (!Array.isArray(parts) || parts.length === 0) return "";

  const textParts = parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean);

  if (textParts.length > 0) {
    return textParts.join("\n\n");
  }

  const reasoningParts = parts
    .filter((part) => part?.type === "reasoning" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean);

  return reasoningParts.join("\n\n");
}

async function sleep(ms: number, abort: AbortSignal): Promise<void> {
  if (abort.aborted) throw new Error("Debate cancelled by user");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abort.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Debate cancelled by user"));
    };
    abort.addEventListener("abort", onAbort, { once: true });
  });
}

async function listAssistantMessages(
  client: OpencodeClient,
  sessionID: string,
): Promise<Array<{
  id: string;
  created: number;
  completed?: number;
  error?: unknown;
  parts?: PromptPart[];
}>> {
  const listResult = await client.session.messages({
    path: { id: sessionID },
    query: { limit: 100 },
  });
  const raw = listResult as Record<string, unknown> | undefined;
  const listPayload = (raw?.data ?? raw) as
    | Array<{
        info?: {
          id?: string;
          role?: string;
          time?: { created?: number; completed?: number };
          error?: unknown;
        };
        parts?: PromptPart[];
      }>
    | undefined;

  if (!Array.isArray(listPayload)) return [];

  return listPayload
    .filter((msg) => msg?.info?.role === "assistant" && typeof msg.info?.id === "string")
    .map((msg) => ({
      id: msg.info!.id as string,
      created: msg.info?.time?.created ?? 0,
      completed: msg.info?.time?.completed,
      error: msg.info?.error,
      parts: msg.parts,
    }));
}

async function promptSessionAsyncVisible(
  client: OpencodeClient,
  sessionID: string,
  text: string,
  abort: AbortSignal,
  timeoutMs: number,
  model?: ModelConfig,
): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  const existingAssistants = await listAssistantMessages(client, sessionID);
  const existingAssistantIDs = new Set(existingAssistants.map((m) => m.id));

  await client.session.promptAsync({
    path: { id: sessionID },
    body: {
      ...(model ? { model } : {}),
      parts: [{ type: "text", text }],
    },
  });

  while (Date.now() < deadline) {
    if (abort.aborted) throw new Error("Debate cancelled by user");

    const assistants = await listAssistantMessages(client, sessionID);
    const newestNewAssistant = assistants
      .filter(
        (m) =>
          !existingAssistantIDs.has(m.id) &&
          m.created >= startedAt - 1000, // small clock skew tolerance
      )
      .sort((a, b) => b.created - a.created)[0];

    if (newestNewAssistant) {
      if (newestNewAssistant.error) {
        throw new Error(
          `Architect provider error: ${serializeUnknown(newestNewAssistant.error)}`,
        );
      }

      const directText = extractTextFromParts(newestNewAssistant.parts);
      if (directText.trim()) return directText;

      const viaMessage = await waitForMessageText(
        client,
        sessionID,
        newestNewAssistant.id,
        abort,
      );
      if (viaMessage.trim()) return viaMessage;

      if (newestNewAssistant.completed) {
        throw new Error("Architect returned empty response");
      }
    }

    await sleep(500, abort);
  }

  throw new Error(`Architect timed out after ${timeoutMs}ms`);
}

async function waitForMessageText(
  client: OpencodeClient,
  sessionID: string,
  messageID: string,
  abort: AbortSignal,
): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (abort.aborted) throw new Error("Debate cancelled by user");
    try {
      const messageResult = await client.session.message({
        path: { id: sessionID, messageID },
      });
      const raw = messageResult as Record<string, unknown> | undefined;
      const messagePayload = (raw?.data ?? raw) as PromptResponsePayload | undefined;
      const providerError = messagePayload?.info?.error;
      if (providerError) {
        throw new Error(`Architect provider error: ${serializeUnknown(providerError)}`);
      }
      const text = extractTextFromParts(messagePayload?.parts);
      if (text.trim()) return text;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("cancelled by user")) throw err;
      log.debug("Message lookup attempt failed (non-fatal)", {
        sessionID,
        messageID,
        attempt: attempt + 1,
        error: errMsg,
      });
    }
    await sleep(350, abort);
  }
  return "";
}

async function waitForLatestAssistantText(
  client: OpencodeClient,
  sessionID: string,
  abort: AbortSignal,
): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (abort.aborted) throw new Error("Debate cancelled by user");
    try {
      const listResult = await client.session.messages({
        path: { id: sessionID },
        query: { limit: 30 },
      });
      const raw = listResult as Record<string, unknown> | undefined;
      const listPayload = (raw?.data ?? raw) as
        | Array<{ info?: { role?: string; error?: unknown }; parts?: PromptPart[] }>
        | undefined;

      if (Array.isArray(listPayload)) {
        for (let i = listPayload.length - 1; i >= 0; i--) {
          const msg = listPayload[i];
          if (msg?.info?.role !== "assistant") continue;
          if (msg.info.error) {
            throw new Error(`Architect provider error: ${serializeUnknown(msg.info.error)}`);
          }
          const text = extractTextFromParts(msg.parts);
          if (text.trim()) return text;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("cancelled by user")) throw err;
      log.debug("Assistant message scan failed (non-fatal)", {
        sessionID,
        attempt: attempt + 1,
        error: errMsg,
      });
    }
    await sleep(500, abort);
  }
  return "";
}

/**
 * Prompt a sub-session and extract the assistant's text response.
 * Optionally targets a specific model via the SDK's per-prompt model selection.
 *
 * Key design decisions:
 * - Uses the response returned directly from `prompt()` instead of making
 *   a separate `messages()` call (avoids race conditions and extra latency).
 * - On timeout or user abort, calls `session.abort()` to stop the server-side
 *   LLM generation so resources aren't wasted on abandoned prompts.
 * - Properly cleans up the abort listener and timeout timer in all code paths
 *   to prevent memory leaks and unhandled rejections.
 */

async function promptSession(
  client: OpencodeClient,
  sessionID: string,
  text: string,
  abort: AbortSignal,
  timeoutMs: number,
  model?: ModelConfig,
  leadModel?: string,
): Promise<string> {
  const attemptPrompt = async (currentModel?: ModelConfig): Promise<string> => {
    log.debug("Prompting session", {
      sessionID,
      textLength: text.length,
      model: currentModel ? `${currentModel.providerID}/${currentModel.modelID}` : "(default)",
    });

    if (abort.aborted) {
      log.warn("Debate cancelled by user");
      throw new Error("Debate cancelled by user");
    }

    try {
      // Use async prompt flow for better live visibility in attached TUI panes.
      // prompt_async returns immediately, while generation progress appears in
      // session events that the pane can render in real-time.
      let response = "";
      try {
        response = await promptSessionAsyncVisible(
          client,
          sessionID,
          text,
          abort,
          timeoutMs,
          currentModel,
        );
      } catch (asyncErr) {
        const asyncErrMsg = asyncErr instanceof Error ? asyncErr.message : String(asyncErr);
        if (asyncErrMsg.includes("cancelled by user") || asyncErrMsg.includes("timed out")) {
          throw asyncErr;
        }
        // Compatibility fallback for servers that may not fully support
        // prompt_async behavior in this flow.
        log.debug("prompt_async path failed, falling back to prompt()", {
          sessionID,
          model: currentModel ? `${currentModel.providerID}/${currentModel.modelID}` : "(default)",
          error: asyncErrMsg,
        });

        const result = await client.session.prompt({
          path: { id: sessionID },
          body: {
            ...(currentModel ? { model: currentModel } : {}),
            parts: [{ type: "text", text }],
          },
        });

        const raw = result as Record<string, unknown> | undefined;
        const promptResponse = (raw?.data ?? raw) as PromptResponsePayload | undefined;

        if (raw && "error" in raw && raw.error) {
          log.error("Prompt returned an error", { sessionID, error: raw.error });
          throw new Error(`Prompt failed: ${JSON.stringify(raw.error)}`);
        }
        if (promptResponse?.info?.error) {
          throw new Error(
            `Architect provider error: ${serializeUnknown(promptResponse.info.error)}`,
          );
        }

        response = extractTextFromParts(promptResponse?.parts);
        if (!response.trim() && promptResponse?.info?.id) {
          response = await waitForMessageText(
            client,
            sessionID,
            promptResponse.info.id,
            abort,
          );
        }
        if (!response.trim()) {
          response = await waitForLatestAssistantText(client, sessionID, abort);
        }
      }

      if (!response.trim()) {
        log.error("Architect returned empty response", { sessionID });
        throw new Error("Architect returned empty response");
      }

      log.debug("Received response", {
        sessionID,
        responseLength: response.length,
      });
      return response;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errName = err instanceof Error ? err.constructor.name : typeof err;
      const timedOutOrAborted =
        errMsg.includes("timed out") || errMsg.includes("cancelled by user");
      log.error("promptSession failed", {
        sessionID,
        errorType: errName,
        error: errMsg,
        timedOutOrAborted,
        model: currentModel ? `${currentModel.providerID}/${currentModel.modelID}` : "(default)",
      });

      if (timedOutOrAborted) {
        log.debug("Aborting server-side session after timeout/cancel", { sessionID });
        client.session.abort({ path: { id: sessionID } }).catch((e) =>
          log.warn("Failed to abort session (non-fatal)", { sessionID, error: e }),
        );
      }
      throw err;
    }
  };

  try {
    return await attemptPrompt(model);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // DO NOT retry or fallback if user explicitly aborted or timeout occurred
    if (errMsg.includes("cancelled by user") || errMsg.includes("timed out")) {
      throw err;
    }

    log.warn("Primary model failed, attempting retry with same model first", {
      model: model ? `${model.providerID}/${model.modelID}` : "(default)",
      error: errMsg,
    });

    try {
      // 1. Give it a tiny delay to recover from transient server glitches
      await new Promise((r) => setTimeout(r, 1000));
      return await attemptPrompt(model);
    } catch (retryErr) {
      const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      if (retryErrMsg.includes("cancelled by user") || retryErrMsg.includes("timed out")) {
        throw retryErr;
      }

      log.warn("Retry failed, now attempting fallback models", {
        failedModel: model ? `${model.providerID}/${model.modelID}` : "(default)",
        error: retryErrMsg,
      });

      let lastErr = retryErr;
      
      // Prioritize leadModel if available, then fallback models.
      const candidates = [...FALLBACK_MODELS];
      if (leadModel && !candidates.includes(leadModel)) {
        candidates.unshift(leadModel);
      }

      for (const fallbackModelStr of candidates) {
        if (abort.aborted) throw new Error("Debate cancelled by user");

        const fallbackModel = parseModelString(fallbackModelStr);
        // Skip if it's the same model we just tried
        if (
          model &&
          model.providerID === fallbackModel.providerID &&
          model.modelID === fallbackModel.modelID
        ) {
          continue;
        }

        try {
          log.info(`Retrying with fallback model: ${fallbackModelStr}`);
          // Tiny delay before each fallback
          await new Promise((r) => setTimeout(r, 1000));
          return await attemptPrompt(fallbackModel);
        } catch (fallbackErr) {
          const fbErrMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          log.warn(`Fallback model ${fallbackModelStr} also failed`, { error: fbErrMsg });
          lastErr = fallbackErr;
          
          if (fbErrMsg.includes("cancelled by user") || fbErrMsg.includes("timed out")) {
            throw fallbackErr;
          }
        }
      }

      log.error("All fallback models failed.");
      throw lastErr;
    }
  }
}

/**
 * Permissions pre-granted to architect sub-sessions at creation time.
 *
 * Passed as an extra `permission` field in the session create body.
 * The opencode server accepts this field and applies it to the session,
 * so tool calls from these sessions never block waiting for human approval.
 */
const ARCHITECT_PERMISSIONS = [
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "bash", pattern: "*", action: "allow" },
  { permission: "edit", pattern: "*", action: "allow" },
  { permission: "write", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "webfetch", pattern: "*", action: "allow" },
];

/**
 * Create an architect sub-session with all permissions pre-granted.
 *
 * Uses the existing v1 client (already configured with proper headers/auth)
 * but casts the body to include `permission` — a field the server supports
 * even though it's not exposed in the v1 TypeScript types.
 */
async function createArchitectSession(
  client: OpencodeClient,
  params: { parentID: string; title: string },
): Promise<string> {
  const result = await client.session.create({
    body: {
      parentID: params.parentID,
      title: params.title,
      permission: ARCHITECT_PERMISSIONS,
    } as { parentID: string; title: string },
  });
  const raw = result as { data?: { id?: string }; error?: unknown };
  log.debug("session.create result", { data: raw.data, error: raw.error });
  const id = raw.data?.id;
  if (!id) {
    log.error("Session creation failed", { error: raw.error, data: raw.data, title: params.title });
    throw new Error(
      `Failed to create session "${params.title}": ${JSON.stringify(raw.error ?? raw.data)}`,
    );
  }
  log.debug("Created architect session with pre-granted permissions", { id, title: params.title });
  return id;
}

/**
 * Run the pair programming debate protocol.
 *
 * Flow:
 * 1. Create two sub-sessions (proposer + critic)
 * 2. Launch opencode TUI in tmux panes (each with its own model)
 * 3. Proposer proposes based on lead's vision + project context
 * 4. Critic reviews with structured JSON verdict
 * 5. Loop until consensus (approved:true AND score>=7) or maxRounds
 * 6. Clean up sessions and tmux panes
 *
 * Each architect can use a different LLM model. When running inside tmux,
 * two opencode TUI instances are launched in split panes so the user
 * sees each architect working in real-time — not just a log tail.
 */
export async function runDebate(
  client: OpencodeClient,
  ctx: Pick<PluginInput, "$" | "directory">,
  input: DebateInput,
): Promise<ProtocolResult> {
  const { vision, projectContext, config, abort } = input;
  const emitToLegacyStatus = (status: string) => {
    if (!input.onStatus) return;
    try {
      Promise.resolve(input.onStatus(status)).catch((err) => {
        const error = err instanceof Error ? `${err.message} (${err.name})` : String(err);
        log.warn("Status callback failed", {
          error,
        });
      });
    } catch (err) {
      const error = err instanceof Error ? `${err.message} (${err.name})` : String(err);
      log.warn("Status callback failed", {
        error,
      });
    }
  };
  const emitVisibility = (event: DebateVisibilityEvent, force = false) => {
    const message = event.message.trim();
    if (!message) return;
    log.info(message);

    if (input.onVisibility) {
      try {
        Promise.resolve(input.onVisibility(event)).catch((err) => {
          const error = err instanceof Error ? `${err.message} (${err.name})` : String(err);
          log.warn("Visibility callback failed", {
            error,
          });
        });
      } catch (err) {
        const error = err instanceof Error ? `${err.message} (${err.name})` : String(err);
        log.warn("Visibility callback failed", {
          error,
        });
      }
      return;
    }

    emitToLegacyStatus(message);

    if (force && event.kind === "failure") {
      log.debug("Force emitted failure event", {
        message,
      });
    }
  };
  let terminalEmitted = false;
  const emitTerminalVisibility = (event: DebateVisibilityEvent) => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    emitVisibility(event, true);
  };
  const notify = (status: string) => {
    emitVisibility(
      {
        kind: "thinking",
        message: status,
        variant: "info",
      },
      true,
    );
  };
  const getAgentLabel = (agent: "proposer" | "critic") =>
    agent === "proposer" ? "Architect-1 (Proposer)" : "Architect-2 (Critic)";
  const formatRound = (round = 0) =>
    round > 0 ? `Round ${round}/${config.maxRounds}` : "Setup";

  let activeRound = 0;
  let lastLiveStatus = "";
  let lastLiveStatusAt = 0;
  const emitLiveStatus = (
    status: string,
    kind: DebateVisibilityEvent["kind"],
    force = false,
    agent?: DebateAgent,
    round?: number,
    variant: DebateVisibilityEvent["variant"] = "info",
  ) => {
    const now = Date.now();
    const tooSoon = now - lastLiveStatusAt < 3000;
    if (!force && (status === lastLiveStatus || tooSoon)) {
      return;
    }
    lastLiveStatus = status;
    lastLiveStatusAt = now;
    emitVisibility(
      {
        kind,
        message: status,
        agent,
        round,
        variant,
      },
      force,
    );
  };
  const setLiveStatus = (
    agent: "proposer" | "critic",
    status: string,
    logAsInfo = false,
    round?: number,
    kind: DebateVisibilityEvent["kind"] = "thinking",
  ) => {
    const next = `${formatRound(round ?? activeRound)}: ${getAgentLabel(agent)} ${status}`;
    if (logAsInfo) {
      log.info(next);
    }
    emitLiveStatus(
      next,
      kind,
      logAsInfo,
      agent,
      round ?? activeRound,
      logAsInfo ? "info" : "info",
    );
  };
  const promptWithProgress = async (params: {
    agent: "proposer" | "critic";
    sessionID: string;
    promptText: string;
    timeoutMs: number;
    model?: ModelConfig;
    leadModel?: string;
    phase: string;
    round?: number;
  }): Promise<string> => {
    const started = Date.now();
    setLiveStatus(params.agent, `${params.phase}...`, true, params.round);
    let tick = 0;
    const ticker = setInterval(() => {
      tick++;
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      if (tick % 3 === 0) {
        // Emit periodic "thinking" heartbeat so the lead session can surface
        // progress even while no new assistant message has completed yet.
        setLiveStatus(
          params.agent,
          `${params.phase} in progress (thinking ${elapsedSec}s)`,
          false,
          params.round,
        );
      }
      if (tick % 4 === 0) {
        log.debug("Agent still working", {
          agent: params.agent,
          phase: params.phase,
          elapsedSec,
          sessionID: params.sessionID,
        });
      }
    }, 3000);

    try {
      const response = await promptSession(
        client,
        params.sessionID,
        params.promptText,
        abort,
        params.timeoutMs,
        params.model,
        params.leadModel,
      );
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      setLiveStatus(
        params.agent,
        `completed ${params.phase} (${elapsedSec}s)`,
        true,
        params.round,
      );
      return response;
    } finally {
      clearInterval(ticker);
    }
  };
  const proposerPersona = config.proposerPersona ?? PROPOSER_PERSONA;
  const criticPersona = config.criticPersona ?? CRITIC_PERSONA;

  // Parse model configs. If explicit architect models are not configured,
  // prefer the lead model captured from the main session, unless it is
  // known unstable for the architect prompt flow.
  const safeLeadModel = isModelUnsafeForArchitect(config.leadModel)
    ? undefined
    : config.leadModel;
  if (config.leadModel && !safeLeadModel) {
    log.warn("Ignoring unstable lead model for architect debate", {
      leadModel: config.leadModel,
    });
  }

  const defaultArchitectModel = FALLBACK_MODELS[0];
  const proposerModelString = config.proposerModel ?? safeLeadModel ?? defaultArchitectModel;
  const criticModelString = config.criticModel ?? safeLeadModel ?? defaultArchitectModel;

  const proposerModel = proposerModelString
    ? parseModelString(proposerModelString)
    : undefined;
  const criticModel = criticModelString
    ? parseModelString(criticModelString)
    : undefined;

  log.info("Starting debate", {
    vision: vision.slice(0, 100),
    maxRounds: config.maxRounds,
    timeoutMs: config.timeoutMs,
    proposerModel: proposerModelString ?? "(session default)",
    criticModel: criticModelString ?? "(session default)",
  });

  const sessions = { proposer: "", critic: "" };
  let tmuxView: TmuxDebateView | null = null;

  try {
    emitVisibility({
      kind: "setup",
      message: "Setup: creating architect sessions",
      variant: "info",
    }, true);
    // ── 1. Create peer sub-sessions in parallel (with pre-granted permissions) ──
    // Permission is embedded in the create body so tool calls from these sessions
    // never block waiting for a human to approve them.
    log.debug("Creating proposer and critic sessions in parallel (with pre-granted permissions)");
    const [proposerID, criticID] = await Promise.all([
      createArchitectSession(client, {
        parentID: input.parentSessionID,
        title: `Architect-1 (Proposer): ${vision.slice(0, 50)}`,
      }),
      createArchitectSession(client, {
        parentID: input.parentSessionID,
        title: `Architect-2 (Critic): ${vision.slice(0, 50)}`,
      }),
    ]);
    sessions.proposer = proposerID;
    sessions.critic = criticID;
    // Also register in the shared set as a belt-and-suspenders safety net
    // in case the permission.ask hook fires for any edge-case requests.
    input.architectSessions?.add(sessions.proposer);
    input.architectSessions?.add(sessions.critic);
    log.debug("Both sessions created with permissions", {
      proposer: sessions.proposer,
      critic: sessions.critic,
    });
    emitVisibility({
      kind: "setup",
      message: "Setup: architect sessions ready",
    });

    // ── 2. Launch tmux panes AND start initial proposal in parallel ─
    //    Also run critic preparation in parallel so Architect-2 does not idle.
    //    The TUI view is cosmetic — prompt execution doesn't depend on panes.
    log.debug("Launching tmux view, proposer draft, and critic prep in parallel");
    activeRound = 1;
    const criticPreparationTask = promptWithProgress({
      agent: "critic",
      sessionID: sessions.critic,
      promptText: buildCriticPreparationPrompt(criticPersona, projectContext, vision),
      timeoutMs: config.timeoutMs,
      model: criticModel,
      leadModel: config.leadModel,
      round: 0,
      phase: "preparing review plan",
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("cancelled by user") || errMsg.includes("timed out")) {
        throw err;
      }
      log.warn("Critic preparation failed; continuing without prep context", { error: errMsg });
      setLiveStatus("critic", "prep skipped, will critique proposal", true, 0, "thinking");
      return "";
    });

    const [tmuxResult, initialProposal, criticPreparation] = await Promise.all([
      createTmuxDebateView({
        $: ctx.$,
        proposerSessionId: sessions.proposer,
        criticSessionId: sessions.critic,
        proposerModel: proposerModelString,
        criticModel: criticModelString,
        serverUrl: input.serverUrl,
      }),
      promptWithProgress({
        agent: "proposer",
        sessionID: sessions.proposer,
        promptText: buildInitialProposerPrompt(proposerPersona, projectContext, vision),
        timeoutMs: config.timeoutMs,
        model: proposerModel,
        leadModel: config.leadModel,
        round: 1,
        phase: "drafting initial proposal",
      }),
      criticPreparationTask,
    ]);
    setLiveStatus("proposer", "submitted initial proposal", true, 1, "thinking");
    setLiveStatus("critic", "waiting to review initial proposal", true, 1, "thinking");
    notify("Round 1 proposal draft and preparation completed");

    tmuxView = tmuxResult;
    if (tmuxView) {
      emitVisibility({
        kind: "setup",
        message: "Setup: connected to live TMUX panes",
      });
      log.info("Tmux debate view launched with opencode TUI instances", {
        proposerPane: tmuxView.proposer.paneId,
        criticPane: tmuxView.critic.paneId,
      });
    } else {
      emitVisibility({
        kind: "setup",
        message: "Setup: tmux unavailable; using status stream only",
      });
      log.warn(
        "Tmux debate view was NOT created — debate will proceed without live TUI panes. " +
        "Check the plugin log at ~/.local/share/opencode/effective-opencode.log for details.",
        {
          hasTMUX: !!process.env.TMUX,
          hasTMUX_PANE: !!process.env.TMUX_PANE,
          serverUrl: input.serverUrl ?? "(unset)",
        },
      );
    }

    // ── 3. Run debate rounds ─────────────────────────────────────
    const rounds: DialogueRound[] = [];

    let proposal = initialProposal;

    for (let i = 0; i < config.maxRounds; i++) {
        log.info(`Round ${i + 1}/${config.maxRounds}`);
        activeRound = i + 1;
        setLiveStatus("critic", "starting review", true, i + 1);

      // Critic reviews
      let critiquePrompt =
        i === 0
          ? buildInitialCritiquePrompt(
              criticPersona,
              projectContext,
              proposal,
            )
          : buildCritiquePrompt(proposal, i + 1, config.maxRounds);
      if (i === 0 && criticPreparation.trim()) {
        critiquePrompt += `\n\n## Prior Review Notes (Prepared Earlier)\n${criticPreparation}\n\nUse these notes as guidance while evaluating the proposal.`;
      }

      const critique = await promptWithProgress({
        agent: "critic",
        sessionID: sessions.critic,
        promptText: critiquePrompt,
        timeoutMs: config.timeoutMs,
        model: criticModel,
        leadModel: config.leadModel,
        round: i + 1,
        phase: `reviewing proposal for round ${i + 1}/${config.maxRounds}`,
      });

      const verdict = parseVerdict(critique);
      if (verdict) {
        log.debug("Verdict parsed", {
          approved: verdict.approved,
          score: verdict.score,
        });
      }

      const round: DialogueRound = {
        round: i + 1,
        proposal,
        critique,
        verdict,
      };
      rounds.push(round);
      input.onRound(round);
      const score = round.verdict?.score;
      const approved = round.verdict?.approved;
      const issueCount = round.verdict?.key_issues?.length ?? 0;
      const status =
        score === undefined
          ? "critique parsed without verdict"
          : `${approved ? "approved" : "needs revision"} (${score}/10, issues: ${issueCount})`;
      const topIssue = round.verdict?.key_issues?.[0];
      emitVisibility({
        kind: "round_result",
        round: i + 1,
        agent: "critic",
        message:
          `Round ${i + 1}/${config.maxRounds}: Critic ${status}` +
          (topIssue ? ` · top feedback: ${topIssue}` : ""),
        variant: round.verdict?.approved ? "success" : "info",
      });

      // Consensus check
      const consensus = detectConsensus(critique);
      if (consensus.reached) {
        log.info("Consensus reached!", {
          round: i + 1,
          summary: consensus.summary,
        });
        setLiveStatus("proposer", "confirmed consensus", true, i + 1, "consensus");
        setLiveStatus("critic", "confirmed consensus", true, i + 1, "consensus");
        emitTerminalVisibility({
          kind: "consensus",
          round: i + 1,
          message: `Round ${i + 1}: Consensus reached!`,
          variant: "success",
        });
        notify(`Round ${i + 1}: Consensus reached!`);
        const transcriptPath = await saveTranscript(
          ctx,
          vision,
          rounds,
          true,
          consensus.summary,
        );
        return {
          rounds,
          finalDesign: proposal,
          consensus: true,
          summary: consensus.summary,
          transcriptPath,
        };
      }

      // Proposer revises (skip on last round)
      if (i < config.maxRounds - 1) {
        setLiveStatus("critic", "waiting for revised proposal", true, i + 1);
        proposal = await promptWithProgress({
          agent: "proposer",
          sessionID: sessions.proposer,
          promptText: buildRevisionPrompt(critique, verdict, rounds, i + 1),
          timeoutMs: config.timeoutMs,
          model: proposerModel,
          leadModel: config.leadModel,
          round: i + 1,
          phase: `revising proposal for round ${i + 1}/${config.maxRounds}`,
        });
      }
    }

    log.warn("Max rounds reached without consensus", {
      rounds: config.maxRounds,
    });

    const summary = "Max rounds reached without full consensus";
    setLiveStatus("proposer", "completed max rounds without consensus", true, activeRound, "complete");
    setLiveStatus("critic", "completed max rounds without consensus", true, activeRound, "complete");
    emitTerminalVisibility({
      kind: "complete",
      round: activeRound,
      message: "Max rounds reached without full consensus",
      variant: "warning",
    });
    const transcriptPath = await saveTranscript(
      ctx,
      vision,
      rounds,
      false,
      summary,
    );

    return {
      rounds,
      finalDesign: proposal,
      consensus: false,
      summary,
      transcriptPath,
    };
  } catch (err) {
    // Log the error that caused the debate to fail so it's always visible
    // in the plugin log file, even if the caller swallows the exception.
    const errMsg = err instanceof Error ? err.message : String(err);
    const errName = err instanceof Error ? err.constructor.name : typeof err;
    const errStack = err instanceof Error ? err.stack : undefined;
    const cancelled = errMsg.includes("Debate cancelled by user");
    emitTerminalVisibility({
      kind: cancelled ? "cancelled" : "failure",
      round: activeRound,
      message: cancelled ? "Debate cancelled by user" : `Debate failed: ${errMsg}`,
      variant: cancelled ? "warning" : "error",
    });
    log.error("runDebate failed", {
      errorType: errName,
      error: errMsg,
      stack: errStack,
      proposerSession: sessions.proposer,
      criticSession: sessions.critic,
    });
    throw err;
  } finally {
    // ── 4. Cleanup ───────────────────────────────────────────────
    // Deregister from the permission auto-approve set first, so no further
    // tool calls are approved for these sessions after cleanup starts.
    input.architectSessions?.delete(sessions.proposer);
    input.architectSessions?.delete(sessions.critic);

    if (tmuxView) {
      setLiveStatus("proposer", "cleaning up", true, activeRound);
      setLiveStatus("critic", "cleaning up", true, activeRound);
      await tmuxView.cleanup();
    }

    if (!config.retainSessions) {
      log.debug("Cleaning up sessions");
      if (sessions.proposer) {
        await client.session
          .delete({ path: { id: sessions.proposer } })
          .catch((e) => log.warn("Failed to delete proposer session", e));
      }
      if (sessions.critic) {
        await client.session
          .delete({ path: { id: sessions.critic } })
          .catch((e) => log.warn("Failed to delete critic session", e));
      }
    }
  }
}

/**
 * Save the full debate transcript to .opencode/architect-debates/
 */
async function saveTranscript(
  ctx: Pick<PluginInput, "$" | "directory">,
  vision: string,
  rounds: DialogueRound[],
  consensus: boolean,
  summary: string,
): Promise<string | undefined> {
  try {
    const dir = `${ctx.directory}/.opencode/architect-debates`;
    await ctx.$`mkdir -p ${dir}`;
    const filename = `${Date.now()}.md`;
    const path = `${dir}/${filename}`;
    const content = formatFullTranscript(vision, rounds, consensus, summary);
    await Bun.write(path, content);
    log.info("Transcript saved", { path });
    return `.opencode/architect-debates/${filename}`;
  } catch (e) {
    log.error("Failed to save transcript", e);
    return undefined;
  }
}
