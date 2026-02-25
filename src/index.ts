import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type {
  PluginConfig,
  AppConfig,
  ToolExecuteEventPayload,
  ToolExecuteInput,
  ToolExecuteOutput,
  SystemTransformOutput,
} from "./types";
import { DEFAULT_CONFIG } from "./types";
import { runDebate } from "./debate-engine";
import { gatherProjectContext, invalidateContextCache } from "./context";
import { shouldInvalidateContextCacheFromToolEvent } from "./context/mutation-policy";
import { formatCondensedResult } from "./prompts";
import { createContextLogger } from "./logger";
import { resolveLeadModel } from "./model-utils";

import { appendAuditSummary } from "./improvement-audit/format";
import { buildAuditVision } from "./improvement-audit/prompt";
import { buildSyntheticAuditFailureOutcome } from "./improvement-audit/synthetic-outcome";
import {
  parseArchitectArgs,
} from "./improvement-audit/args";
import type {
  ParsedArchitectArgs,
  AppLevelImprovementAuditPolicy,
  ResolvedImprovementAuditPolicy,
  ImprovementAuditOutcome,
} from "./improvement-audit/types";
import { runImprovementAudit } from "./improvement-audit/pipeline";
import {
  resolveExecutionPolicy,
} from "./improvement-audit/policy";
import { ArchitectRunScopeManager } from "./improvement-audit/scope-manager";

// Security & Skills Engine
import { AuthorizationEngine } from "./security/index";
import { parseBashCommand } from "./security/command-parser";
import { ContextAwareSkillLoader } from "./skills/index";

// Refactoring Engine
import { RefactorEngine } from "./refactor/index";
import { TimeBudgetManager } from "./time-budget/manager";
import {
  extractTimeBudgetMinutes,
  resolveTimeBudgetIntent,
} from "./time-budget/intent-parser";

const log = createContextLogger("plugin");

export const EffectiveOpencodePlugin: Plugin = async (ctx: PluginInput) => {
  let pluginConfig: PluginConfig = {
    ...DEFAULT_CONFIG,
    timeBudget: {
      ...DEFAULT_CONFIG.timeBudget,
      compactProgressCheckpoints: [...DEFAULT_CONFIG.timeBudget.compactProgressCheckpoints],
    },
  };
  const updateLeadModel = (candidate: unknown, source: string) => {
    const resolved = resolveLeadModel(candidate);
    if (!resolved) return;
    if (pluginConfig.leadModel !== resolved) {
      const previous = pluginConfig.leadModel;
      pluginConfig.leadModel = resolved;
      log.debug("Updated lead model", {
        source,
        previous: previous ?? "(unset)",
        next: resolved,
      });
    }
  };

  // 1. Initialize Security & Skills Engine
  const authEngine = new AuthorizationEngine(ctx.directory);
  const skillLoader = new ContextAwareSkillLoader(ctx.directory);

  // 2. Track recently accessed files for conditional context loading
  const recentContext: Set<string> = new Set();

  // 3. Track active architect run scopes for recursion safety and permissions.
  const scopeManager = new ArchitectRunScopeManager();
  const isAutoApprovableSession = (sessionID: string): boolean =>
    scopeManager.isKnownSession(sessionID);

  // 4. Track app-configured audit policy blocks by precedence source.
  let appAuditConfig: AppLevelImprovementAuditPolicy | undefined;
  let legacyAuditConfig: AppLevelImprovementAuditPolicy | undefined;
  const pendingTimeIntentSessions = new Set<string>();
  const timeBudgetDecisionPromptedSessions = new Set<string>();
  const approvedTimeBudgetSessions = new Set<string>();
  const nonLeadSessions = new Set<string>();
  const sessionModelContextLimit = new Map<string, number>();
  const sessionAgentMode = new Map<string, string>();

  const clearTimeBudgetIntentState = (sessionID: string): void => {
    pendingTimeIntentSessions.delete(sessionID);
    timeBudgetDecisionPromptedSessions.delete(sessionID);
    approvedTimeBudgetSessions.delete(sessionID);
  };

  const disableStrictTimeBudget = (sessionID: string): void => {
    timeBudgetManager.clearBudget(sessionID);
    clearTimeBudgetIntentState(sessionID);
  };

  const clearTimeBudgetSessionState = (sessionID: string): void => {
    timeBudgetManager.clearBudget(sessionID);
    clearTimeBudgetIntentState(sessionID);
    nonLeadSessions.delete(sessionID);
    sessionModelContextLimit.delete(sessionID);
    sessionAgentMode.delete(sessionID);
  };

  const canUseEffectiveTool = (sessionID: string): boolean => {
    if (scopeManager.isKnownSession(sessionID)) return false;
    const mode = sessionAgentMode.get(sessionID);
    return mode === "effective";
  };

  const isLeadSession = (sessionID: string, agent?: string): boolean => {
    if (scopeManager.isKnownSession(sessionID)) return false;
    if (!agent) return true;
    const normalized = agent.trim().toLowerCase();
    return normalized === "default" || normalized === "lead";
  };

  const extractTextFromParts = (parts: unknown[]): string => {
    if (!Array.isArray(parts)) return "";
    return parts
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const candidate = part as { type?: unknown; text?: unknown };
        if (candidate.type !== "text" || typeof candidate.text !== "string") {
          return "";
        }
        return candidate.text;
      })
      .filter(Boolean)
      .join("\n");
  };

  const extractTextFromMessageLike = (message: unknown): string => {
    if (!message || typeof message !== "object") return "";
    const candidate = message as { parts?: unknown[]; text?: unknown };
    if (Array.isArray(candidate.parts)) {
      const fromParts = extractTextFromParts(candidate.parts);
      if (fromParts) return fromParts;
    }
    if (typeof candidate.text === "string") return candidate.text;
    return "";
  };

  const extractTextFromMessageList = (messages: unknown): string => {
    if (!Array.isArray(messages)) return "";
    return messages
      .map((message) => {
        if (!message || typeof message !== "object") return "";
        const candidate = message as {
          role?: unknown;
          content?: unknown;
          parts?: unknown[];
          text?: unknown;
        };
        if (candidate.role && candidate.role !== "user") return "";
        if (typeof candidate.content === "string") return candidate.content;
        if (Array.isArray(candidate.content)) {
          const fromContentParts = extractTextFromParts(candidate.content);
          if (fromContentParts) return fromContentParts;
        }
        if (Array.isArray(candidate.parts)) {
          const fromParts = extractTextFromParts(candidate.parts);
          if (fromParts) return fromParts;
        }
        if (typeof candidate.text === "string") return candidate.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  };

  const formatDuration = (ms: number): string => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }
    return `${minutes}m ${seconds}s`;
  };

  const asUnitRatio = (value: unknown): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (value <= 0 || value > 1) return undefined;
    return value;
  };

  const asPositiveInt = (value: unknown): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.floor(value);
  };

  const parseCheckpointRatios = (value: unknown): number[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const parsed = value
      .map(asUnitRatio)
      .filter((ratio): ratio is number => ratio !== undefined)
      .sort((a, b) => a - b);
    if (parsed.length === 0) return undefined;
    return [...new Set(parsed)];
  };

  const applyTimeBudgetOverrides = (source: unknown) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return;
    const tb = (source as { timeBudget?: unknown }).timeBudget;
    if (!tb || typeof tb !== "object" || Array.isArray(tb)) return;
    const candidate = tb as Record<string, unknown>;
    if (typeof candidate.enabled === "boolean") {
      pluginConfig.timeBudget.enabled = candidate.enabled;
    }
    const finalizingThreshold = asUnitRatio(candidate.finalizingThreshold);
    if (finalizingThreshold !== undefined) {
      pluginConfig.timeBudget.finalizingThreshold = finalizingThreshold;
    }

    const compactSoftThreshold = asUnitRatio(candidate.compactSoftThreshold);
    if (compactSoftThreshold !== undefined) {
      pluginConfig.timeBudget.compactSoftThreshold = compactSoftThreshold;
    }

    const compactHardThreshold = asUnitRatio(candidate.compactHardThreshold);
    if (compactHardThreshold !== undefined) {
      pluginConfig.timeBudget.compactHardThreshold = compactHardThreshold;
    }

    const compactCooldownMs = asPositiveInt(candidate.compactCooldownMs);
    if (compactCooldownMs !== undefined) {
      pluginConfig.timeBudget.compactCooldownMs = compactCooldownMs;
    }

    const timerChunkMs = asPositiveInt(candidate.timerChunkMs);
    if (timerChunkMs !== undefined) {
      pluginConfig.timeBudget.timerChunkMs = timerChunkMs;
    }

    const compactProgressCheckpoints = parseCheckpointRatios(candidate.compactProgressCheckpoints);
    if (compactProgressCheckpoints) {
      pluginConfig.timeBudget.compactProgressCheckpoints = compactProgressCheckpoints;
    }
  };

  const timeBudgetManager = new TimeBudgetManager({
    config: pluginConfig.timeBudget,
    onExpired: async (sessionID: string) => {
      log.warn("Time budget expired; entering finalization-only mode", { sessionID });
    },
  });

  const resolveAuditPolicy = (parsedArgs: ParsedArchitectArgs) => {
    const preferredPolicy = appAuditConfig ?? legacyAuditConfig;
    const args = parsedArgs;
    return resolveExecutionPolicy(preferredPolicy, {
      auditProfile: args.auditProfile,
      maxRounds: args.maxRounds,
      maxFindings: args.maxFindings,
      includeAuditOutput: args.includeAuditOutput,
    });
  };

  const parseAppAuditPolicy = (
    configValue: unknown,
  ): AppLevelImprovementAuditPolicy | undefined => {
    if (!configValue || typeof configValue !== "object" || Array.isArray(configValue)) {
      return undefined;
    }

    const candidate = (configValue as { improvementAudit?: unknown }).improvementAudit;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return undefined;
    }

    return candidate as AppLevelImprovementAuditPolicy;
  };

  const buildDebateConfig = (
    parsedArgs: ParsedArchitectArgs,
    policy?: ResolvedImprovementAuditPolicy,
  ): PluginConfig => {
    const maxRounds = parsedArgs.maxRounds ?? pluginConfig.maxRounds;
    const boundedRounds =
      policy && parsedArgs.executionMode === "improvement-audit"
        ? Math.min(maxRounds, policy.maxRoundsCap)
        : maxRounds;

    return {
      ...pluginConfig,
      maxRounds: boundedRounds,
    };
  };

  return {
    config: async (appConfig: unknown) => {
      // ── Plugin-specific config overrides ──────────────────────────
      const config = appConfig as AppConfig;
      const overrides = config?.effectiveOpencode || config?.architectPlugin;
      if (overrides && typeof overrides === "object") {
        if (typeof overrides.maxRounds === "number")
          pluginConfig.maxRounds = overrides.maxRounds;
        if (typeof overrides.retainSessions === "boolean")
          pluginConfig.retainSessions = overrides.retainSessions;
        if (typeof overrides.timeoutMs === "number")
          pluginConfig.timeoutMs = overrides.timeoutMs;
        if (overrides.debateMode === "sequential" || overrides.debateMode === "parallel") {
          pluginConfig.debateMode = overrides.debateMode;
        }
        if (typeof overrides.proposerPersona === "string")
          pluginConfig.proposerPersona = overrides.proposerPersona;
        if (typeof overrides.criticPersona === "string")
          pluginConfig.criticPersona = overrides.criticPersona;
        if (typeof overrides.proposerModel === "string")
          pluginConfig.proposerModel = overrides.proposerModel;
        if (typeof overrides.criticModel === "string")
          pluginConfig.criticModel = overrides.criticModel;
        applyTimeBudgetOverrides(overrides);
      }

      appAuditConfig = parseAppAuditPolicy(config?.effectiveOpencode);
      legacyAuditConfig = parseAppAuditPolicy(config?.architectPlugin);

      // ── Inject required agents with full permissions ─────────────────
      // This follows the same reliability idea used by oh-my-opencode-slim:
      // for API-created sub-sessions, predefine agent permissions in config
      // instead of relying only on runtime permission interception.
      const cfg = appConfig as Record<string, unknown>;
      if (!cfg.agent || typeof cfg.agent !== "object") {
        cfg.agent = {};
      }
      const agents = cfg.agent as Record<string, unknown>;
      if (!agents["effective"]) {
        agents["effective"] = {
          name: "effective",
          mode: "primary",
          permission: {
            read: "allow",
            edit: "allow",
            write: "allow",
            bash: "allow",
            webfetch: "allow",
            doom_loop: "allow",
            external_directory: "allow",
          },
        };
        log.debug("Injected effective agent with full permissions into opencode config");
      }
      if (!agents["architect"]) {
        agents["architect"] = {
          name: "architect",
          mode: "subagent",
          permission: {
            read: "allow",
            edit: "allow",
            write: "allow",
            bash: "allow",
            webfetch: "allow",
            doom_loop: "allow",
            external_directory: "allow",
          },
        };
        log.debug("Injected architect agent with full permissions into opencode config");
      }
    },

    // 4. Auto-approve tool permissions for architect sub-sessions.
    //    Without this, the LLM inside a sub-session tries to use tools
    //    (e.g. read project files for context), triggers a permission request,
    //    and hangs indefinitely because no human is watching that session.
    "permission.ask": async (
      input: { sessionID: string; id?: string; type?: string; title?: string },
      output: { status: "ask" | "deny" | "allow" },
    ) => {
      const isArchitect = isAutoApprovableSession(input.sessionID);
      log.info("permission.ask fired", {
        sessionID: input.sessionID,
        permissionID: input.id,
        type: input.type,
        title: input.title,
        isArchitect,
      });
      if (isArchitect) {
        output.status = "allow";
        log.info("permission.ask → allowed for architect session", { sessionID: input.sessionID });
      }
    },

    // 5. Track Context via Event Hook + auto-approve permissions for architect sessions
    event: async ({ event }: { event: unknown }) => {
      const e = event as Record<string, unknown> | null;

      // Auto-approve permission requests from architect sub-sessions via API.
      // This is a fallback for cases where the permission.ask hook does not fire
      // for API-created sub-sessions. The event hook fires for ALL sessions.
      if (e?.type === "permission.updated" && e.properties) {
        const props = e.properties as { sessionID?: string; id?: string };
        const { sessionID, id: permissionID } = props;
        if (sessionID && permissionID && isAutoApprovableSession(sessionID)) {
          log.info("Auto-approving permission for architect sub-session via API", {
            sessionID,
            permissionID,
          });
          ctx.client
            .postSessionIdPermissionsPermissionId({
              path: { id: sessionID, permissionID },
              body: { response: "always" },
            })
            .catch((err: unknown) =>
              log.warn("Failed to auto-approve architect permission", {
                sessionID,
                permissionID,
                error: err,
              }),
            );
        }
      }

      // Preserve per-session time budget state across idle transitions.
      // Cleanup is performed when the session is deleted.
      if (e?.type === "session.deleted" && e.properties) {
        const props = e.properties as { info?: { id?: string } };
        const sessionID = props.info?.id;
        if (sessionID) {
          clearTimeBudgetSessionState(sessionID);
        }
      }

      if (e?.type === "session.compacted" && e.properties) {
        const props = e.properties as { sessionID?: string };
        if (props.sessionID) {
          timeBudgetManager.markCompacted(props.sessionID);
        }
      }

      if (e?.type === "message.updated" && e.properties) {
        const props = e.properties as {
          info?: {
            role?: string;
            sessionID?: string;
            tokens?: { input?: number };
            time?: { completed?: number };
          };
        };
        const info = props.info;
        if (
          info?.role === "assistant" &&
          typeof info.sessionID === "string" &&
          typeof info.tokens?.input === "number"
        ) {
          const sessionID = info.sessionID;
          const contextLimit = sessionModelContextLimit.get(sessionID);
          if (
            pluginConfig.timeBudget.enabled &&
            contextLimit &&
            contextLimit > 0 &&
            info.time?.completed
          ) {
            const usageRatio = info.tokens.input / contextLimit;
            const decision = timeBudgetManager.evaluateCompact(sessionID, usageRatio);
            if (decision.shouldCompact) {
              ctx.client.session
                .command({
                  path: { id: sessionID },
                  body: {
                    command: "session.compact",
                    arguments: "",
                  },
                })
                .then(() => {
                  timeBudgetManager.markCompacted(sessionID);
                  log.info("Triggered session compact due to budget policy", {
                    sessionID,
                    reason: decision.reason,
                    usageRatio,
                  });
                })
                .catch((error: unknown) => {
                  log.warn("Failed to trigger compact via session command", {
                    sessionID,
                    error,
                  });
                });
            }
          }
        }
      }

      const typedEvent = event as ToolExecuteEventPayload | null;
      if (typedEvent?.type === "tool.execute.after" && typedEvent.payload) {
        const { tool: toolName, args } = typedEvent.payload;
        if (
          ["read", "write", "edit"].includes(toolName) &&
          args?.filePath
        ) {
          recentContext.add(args.filePath);
        }

        const cacheDecision = shouldInvalidateContextCacheFromToolEvent(event);
        if (cacheDecision.mutate) {
          invalidateContextCache(ctx.directory);
          log.debug("Invalidated project context cache", {
            tool: toolName,
            reason: cacheDecision.reason,
          });
        }
      }
    },

    // 4. Dynamically Inject Skills into System Prompts & Track Lead Model
    "experimental.chat.system.transform": async (
      input: {
        sessionID?: string;
        model?: { id?: string; providerID?: string; provider?: string };
      },
      output: SystemTransformOutput,
    ) => {
      // Capture lead model from exact model metadata (provider + id) supplied
      // by opencode. Never infer provider from model name.
      if (input.model) {
        updateLeadModel(input.model, "experimental.chat.system.transform");
      }

      if (pluginConfig.timeBudget.enabled && input.sessionID) {
        if (nonLeadSessions.has(input.sessionID) || scopeManager.isKnownSession(input.sessionID)) {
          return;
        }

        const contextLimit = (input.model as { limit?: { context?: number } } | undefined)?.limit
          ?.context;
        if (typeof contextLimit === "number" && contextLimit > 0) {
          sessionModelContextLimit.set(input.sessionID, contextLimit);
        }

        const hasPendingIntent = pendingTimeIntentSessions.has(input.sessionID);
        const snapshot = timeBudgetManager.getSnapshot(input.sessionID);
        if (hasPendingIntent && !snapshot) {
          if (!timeBudgetDecisionPromptedSessions.has(input.sessionID)) {
            timeBudgetDecisionPromptedSessions.add(input.sessionID);
            output.system.push(`
## Time Budget Confirmation Required

The user appears to have requested a time-constrained execution window.
Before doing the main work, you MUST ask for an explicit two-option multiple-choice decision via the \`question\` tool exactly once:
- Option 1: Strict deadline mode (start \`start_time_budget\`)
- Option 2: Continue without strict time budget

Do not continue tool work until the user selects one option.

If the user confirms strict deadline mode, immediately call the tool \
\`start_time_budget\`\
 with the approved duration in minutes, then proceed.

If the user declines strict deadline mode, proceed normally without calling \
\`start_time_budget\`\
.
`);
          }

          output.system.push(`
## Pending Time Budget Decision

- A time-budget intent is currently pending for this session.
- Ask (or re-ask) with the \`question\` tool using two explicit options: strict deadline mode vs continue without strict budget.
- If the latest user reply approves strict deadline mode, call \
\`start_time_budget\`\
 now before additional tool usage.
- If the latest user reply declines strict deadline mode, continue normally and do not call the tool.
`);
        }

        if (snapshot) {
          const remaining = formatDuration(snapshot.remainingMs);
          const elapsedPct = Math.round(snapshot.elapsedRatio * 100);
          const isFinalizing = snapshot.elapsedRatio >= pluginConfig.timeBudget.finalizingThreshold;
          const enforceWorkWindow = snapshot.elapsedRatio < 0.7;
          output.system.push(`
## Active Time Budget

- Remaining: ${remaining}
- Elapsed: ${elapsedPct}%
- Deadline mode: strict

Execution policy:
- Do not expand scope unless critical.
- Treat the approved duration as the planned work window; do not stop early after only a minimal pass.
- Continue meaningful analysis/verification until near the deadline, then finalize with concise handoff.
- Prioritize completion and correctness over optional polish.
- If budget is nearly exhausted, finish with a concise status + remaining risks.
${enforceWorkWindow ? "- HARD RULE: Do not send a final handoff yet. Continue analysis and tool work until at least ~70% of the approved duration has elapsed, unless the user explicitly asks to stop." : ""}
${isFinalizing ? "- CRITICAL: You are in finalization phase. Avoid new tool calls and finalize now." : ""}
`);
        }
      }

      const activeSkills = skillLoader.getActiveSkills(
        Array.from(recentContext),
      );

      for (const skill of activeSkills) {
        output.system.push(
          `## Project Context Skill: ${skill.name}\n${skill.description}\n\n${skill.instructions}`,
        );
      }
    },

    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      if (!pluginConfig.timeBudget.enabled) return;
      const snapshot = timeBudgetManager.getSnapshot(input.sessionID);
      if (!snapshot) return;
      output.context.push(
        [
          "Time-budget critical context:",
          `- Remaining time: ${formatDuration(snapshot.remainingMs)}`,
          `- Elapsed ratio: ${Math.round(snapshot.elapsedRatio * 100)}%`,
          "- Preserve user constraints and unfinished tasks in the compacted summary.",
          "- Emphasize what is complete vs what is pending so the agent can finish quickly.",
        ].join("\n"),
      );
    },

    "chat.message": async (
      input: {
        sessionID: string;
        agent?: string;
        model?: { providerID?: string; modelID?: string; id?: string; provider?: string };
      },
      output: { message: unknown; parts: unknown[] },
    ) => {
      if (input.sessionID && input.agent && typeof input.agent === "string") {
        sessionAgentMode.set(input.sessionID, input.agent.trim().toLowerCase());
      }

      if (input.model) {
        updateLeadModel(input.model, "chat.message");
      }

      if (!pluginConfig.timeBudget.enabled) return;

      const leadSession = isLeadSession(input.sessionID, input.agent);
      if (!leadSession) {
        nonLeadSessions.add(input.sessionID);
        clearTimeBudgetIntentState(input.sessionID);
        return;
      }
      nonLeadSessions.delete(input.sessionID);

      const inputPayload = input as {
        message?: unknown;
        parts?: unknown[];
        text?: unknown;
        prompt?: unknown;
        content?: unknown;
        messages?: unknown;
      };
      const text = [
        extractTextFromParts(output.parts),
        extractTextFromMessageLike(output.message),
        extractTextFromParts(inputPayload.parts ?? []),
        extractTextFromMessageLike(inputPayload.message),
        extractTextFromMessageList(inputPayload.messages),
        typeof inputPayload.text === "string" ? inputPayload.text : "",
        typeof inputPayload.prompt === "string" ? inputPayload.prompt : "",
        typeof inputPayload.content === "string" ? inputPayload.content : "",
      ]
        .filter(Boolean)
        .join("\n");
      const intent = resolveTimeBudgetIntent(text);
      if (input.sessionID && intent.action === "decline") {
        disableStrictTimeBudget(input.sessionID);
      } else if (
        input.sessionID &&
        intent.action === "approve" &&
        pendingTimeIntentSessions.has(input.sessionID) &&
        timeBudgetDecisionPromptedSessions.has(input.sessionID)
      ) {
        approvedTimeBudgetSessions.add(input.sessionID);
      } else if (input.sessionID && intent.hasNumeric) {
        const minutes = extractTimeBudgetMinutes(text);
        if (minutes && minutes >= 1) {
          timeBudgetManager.startBudget(input.sessionID, minutes * 60_000);
          clearTimeBudgetIntentState(input.sessionID);
          approvedTimeBudgetSessions.add(input.sessionID);
          log.info("Auto-started strict time budget from explicit duration request", {
            sessionID: input.sessionID,
            minutes,
          });
        } else {
          const wasPending = pendingTimeIntentSessions.has(input.sessionID);
          const wasPrompted = timeBudgetDecisionPromptedSessions.has(input.sessionID);
          pendingTimeIntentSessions.add(input.sessionID);
          if (wasPending && wasPrompted) {
            approvedTimeBudgetSessions.add(input.sessionID);
          } else {
            approvedTimeBudgetSessions.delete(input.sessionID);
            timeBudgetDecisionPromptedSessions.delete(input.sessionID);
          }
        }
      }
    },

    // 5. Intercept Executions for Content-Hashing Security
    "tool.execute.before": async (
      input: ToolExecuteInput,
      output: ToolExecuteOutput,
    ) => {
      const { tool: toolName } = input;
      const args = input.args ?? output.args;
      if (toolName === "effective") {
        if (!canUseEffectiveTool(input.sessionID)) {
          throw new Error(
            "EFFECTIVE_TOOL_RESTRICTED: The effective tool is only available in the effective agent mode. Use the effective agent to run this tool.",
          );
        }
      }
      if (
        pluginConfig.timeBudget.enabled &&
        input.sessionID &&
        toolName !== "question" &&
        toolName !== "start_time_budget" &&
        pendingTimeIntentSessions.has(input.sessionID) &&
        !approvedTimeBudgetSessions.has(input.sessionID)
      ) {
        throw new Error(
          "TIME_BUDGET_CONFIRMATION_REQUIRED: Ask whether to run strict deadline mode before using tools. If approved, call start_time_budget first; if declined, continue without it.",
        );
      }

      if (
        pluginConfig.timeBudget.enabled &&
        input.sessionID &&
        toolName !== "start_time_budget" &&
        timeBudgetManager.shouldBlockTools(input.sessionID)
      ) {
        const snapshot = timeBudgetManager.getSnapshot(input.sessionID);
        if (snapshot && snapshot.remainingMs <= 0) {
          throw new Error(
            "TIME_BUDGET_EXPIRED: The approved time budget is exhausted. Stop tool usage and return the best final summary immediately.",
          );
        }
        throw new Error(
          "TIME_CRITICAL: 95% of the approved time budget has been consumed. Do not run more tools; finalize and summarize now.",
        );
      }

      if (toolName === "bash" && args && typeof args.command === "string") {
        const parsed = parseBashCommand(args.command);
        const command = parsed?.command ?? args.command.trim();
        const commandArgs = parsed?.args ?? [];

        await authEngine.verifyAndAuthorize(
          "bash_execution",
          command,
          commandArgs,
          ctx.directory,
        );
      }
    },

    tool: {
      start_time_budget: tool({
        description:
          "Start a strict time budget for the current session. Call this only after user approval of the requested duration.",
        args: {
          minutes: tool.schema
            .number()
            .describe("Approved budget duration in minutes (must be >= 1)"),
        },
        async execute(args, toolCtx) {
          if (!pluginConfig.timeBudget.enabled) {
            return "Time budget feature is disabled by configuration.";
          }

          const minutes = args.minutes;
          if (!Number.isFinite(minutes) || minutes < 1) {
            return "Invalid minutes value. Please provide a finite number >= 1.";
          }

          if (
            pendingTimeIntentSessions.has(toolCtx.sessionID) &&
            !approvedTimeBudgetSessions.has(toolCtx.sessionID)
          ) {
            return (
              "Time budget confirmation is still pending. " +
              "Ask the user to choose strict deadline mode vs normal mode first, then call start_time_budget after explicit approval."
            );
          }

          const durationMs = Math.floor(minutes * 60_000);
          const state = timeBudgetManager.startBudget(toolCtx.sessionID, durationMs);
          clearTimeBudgetIntentState(toolCtx.sessionID);
          toolCtx.metadata({
            title: `Time budget active: ${Math.round(minutes)} minute(s)`,
          });

          return (
            `Time budget started for ${Math.round(minutes)} minute(s). ` +
            `Remaining window: ${formatDuration(state.deadlineAt - Date.now())}.`
          );
        },
      }),

      effective: tool({
        description:
          "Start a pair programming architecture session. Two AI architects will autonomously debate the design and iterate to consensus. Use when the user wants to design, plan, or architect a system or feature.",
        args: {
          vision: tool.schema
            .string()
            .describe("The lead's vision, requirement, or task description"),
          max_rounds: tool.schema
            .number()
            .optional()
            .describe("Maximum debate rounds (default 3)"),
          execution_mode: tool.schema
            .enum(["debate", "improvement-audit"])
            .optional()
            .describe("Execution mode: debate (legacy) or improvement-audit"),
          max_findings: tool.schema
            .number()
            .optional()
            .describe("Maximum findings cap for improvement-audit mode"),
          include_audit_output: tool.schema
            .boolean()
            .optional()
            .describe("Append improvement-audit summary to the final response"),
          audit_profile: tool.schema
            .enum(["safe", "default", "aggressive"])
            .optional()
            .describe("Audit strictness profile for improvement-audit mode"),
        },
        async execute(args, toolCtx) {
          // Guard against recursive effective invocations from architect
          // sub-sessions. These sessions are intended to respond to prompts,
          // not to spawn nested debate loops.
          if (scopeManager.isKnownSession(toolCtx.sessionID)) {
            log.warn("Blocked recursive effective invocation from architect sub-session", {
              sessionID: toolCtx.sessionID,
            });
            return "Architect sub-sessions cannot invoke the effective tool recursively. Continuing current debate flow.";
          }

          const parsedArgs = parseArchitectArgs(args);
          if (!parsedArgs.ok) {
            return `Invalid effective args: ${parsedArgs.error}`;
          }
          
          let runId: string | undefined;
          let runSessions: Set<string>;
          try {
            runSessions = new Set<string>();
            runId = scopeManager.startRun(toolCtx.sessionID);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `Cannot start effective run: ${message}`;
          }

          let lastMetaTitle = "";
          const setMetaTitle = (title: string) => {
            if (!title || title === lastMetaTitle) return;
            lastMetaTitle = title;
            toolCtx.metadata({ title });
          };
          let lastToastMessage = "";
          let lastToastAt = 0;
          let toastEnabled = true;
          const resolveIncludeAuditOutput = (
            value: boolean | undefined,
            defaultValue: boolean,
          ): boolean => {
            return typeof value === "boolean" ? value : defaultValue;
          };

          // Format time remaining in human-readable format
          const formatTimeRemaining = (sec?: number): string => {
            if (sec === undefined) return "";
            if (sec < 60) return `${sec}s`;
            const mins = Math.floor(sec / 60);
            const remainingSec = sec % 60;
            if (mins < 60) return remainingSec > 0 ? `${mins}m ${remainingSec}s` : `${mins}m`;
            const hours = Math.floor(mins / 60);
            const remainingMins = mins % 60;
            return `${hours}h ${remainingMins}m`;
          };

          // Build intuitive status message with progress bar
          const buildIntuitiveMessage = (
            message: string,
            progress?: {
              currentRound: number;
              totalRounds: number;
              percentage: number;
              timeBudgetRemainingSec?: number;
              timeBudgetTotalSec?: number;
            },
            agentStatus?: {
              thinking?: "proposer" | "critic";
              waiting?: "proposer" | "critic";
            },
          ): string => {
            if (!progress) return message;

            // Build progress bar: [████░░░░░░] 60%
            const barWidth = 10;
            const normalizedPercentage = Math.min(100, Math.max(0, progress.percentage));
            const filled = Math.round((normalizedPercentage / 100) * barWidth);
            const empty = Math.max(0, barWidth - filled);
            const bar = "█".repeat(filled) + "░".repeat(empty);
            
            // Build agent activity indicator
            let agentIndicator = "";
            if (agentStatus?.thinking) {
              const thinkerName = agentStatus.thinking === "proposer" ? "Architect-1" : "Architect-2";
              agentIndicator = ` [${thinkerName} thinking...]`;
            } else if (agentStatus?.waiting) {
              const waiterName = agentStatus.waiting === "proposer" ? "Architect-1" : "Architect-2";
              agentIndicator = ` [${waiterName} waiting]`;
            }

            // Time budget display
            let timeDisplay = "";
            if (progress.timeBudgetRemainingSec !== undefined) {
              timeDisplay = ` | ⏱ ${formatTimeRemaining(progress.timeBudgetRemainingSec)} left`;
            }

            // Round display
            const roundDisplay = `R${progress.currentRound}/${progress.totalRounds}`;

            return `${roundDisplay} [${bar}]${normalizedPercentage}%${timeDisplay}${agentIndicator}`;
          };

          const emitArchitectVisibility = (
            event: {
              kind: string;
              message: string;
              variant?: "info" | "success" | "warning" | "error";
              progress?: {
                currentRound: number;
                totalRounds: number;
                percentage: number;
                timeBudgetRemainingSec?: number;
                timeBudgetTotalSec?: number;
              };
              agentStatus?: {
                thinking?: "proposer" | "critic";
                waiting?: "proposer" | "critic";
              };
            },
          ) => {
            // Build intuitive message with progress bar and agent status
            const intuitiveMessage = buildIntuitiveMessage(
              event.message,
              event.progress,
              event.agentStatus,
            );
            emitArchitectStatus(intuitiveMessage, {
              forceToast: event.kind !== "setup" && event.kind !== "thinking",
              variant: event.variant ?? "info",
            });
          };
          const emitArchitectStatus = (
            title: string,
            options?: {
              forceToast?: boolean;
              variant?: "info" | "success" | "warning" | "error";
            },
          ) => {
            setMetaTitle(title);

            if (!toastEnabled) return;
            if (toolCtx.abort.aborted) return;

            const message = title.trim();
            if (!message) return;

            const now = Date.now();
            const tooSoon = now - lastToastAt < 2500;
            if (!options?.forceToast && (message === lastToastMessage || tooSoon)) {
              return;
            }

            lastToastMessage = message;
            lastToastAt = now;

            // Determine toast duration based on message type
            // Progress updates are shorter, consensus/completion are longer
            const isProgress = message.includes("[") && message.includes("thinking");
            const isComplete = message.includes("consensus") || message.includes("complete") || message.includes("approved");
            const toastDuration = isComplete ? 3500 : isProgress ? 1800 : 2500;

            // Extract title from message for cleaner display
            // Format: "R1/3 [████░░░░░] 60% | ⏱ 5m left [Architect-1 thinking...]"
            let toastTitle = "Architects";
            let toastMessage = message;

            // If message contains round progress, use a cleaner format
            if (message.includes("R") && message.includes("[")) {
              // Extract just the progress part for a cleaner look
              const progressMatch = message.match(/R(\d+)\/(\d+)\s+\[([█░]+)\]\s*(\d+)%/u);
              if (progressMatch) {
                toastTitle = `Round ${progressMatch[1]}/${progressMatch[2]}`;
                toastMessage = `${progressMatch[3]} ${progressMatch[4]}%`;
              }
            } else if (message.includes("consensus")) {
              toastTitle = "✓ Consensus";
            } else if (message.includes("approved")) {
              toastTitle = "✓ Approved";
            } else if (message.includes("Setup")) {
              toastTitle = "Setup";
            }

            ctx.client.tui
              .showToast({
                body: {
                  title: toastTitle,
                  message: toastMessage,
                  variant: options?.variant ?? "info",
                  duration: toastDuration,
                },
              })
              .catch((error: unknown) => {
                toastEnabled = false;
                log.debug("TUI toast unavailable; falling back to metadata title only", {
                  sessionID: toolCtx.sessionID,
                  error,
                });
              });
          };

          try {
            const policy = resolveAuditPolicy(parsedArgs.value);
            const config: PluginConfig = buildDebateConfig(parsedArgs.value, policy);
            const runScopedDebate = (vision: string, context: string) =>
              runDebate(ctx.client, ctx, {
                parentSessionID: toolCtx.sessionID,
                vision,
                projectContext: context,
                config,
                abort: toolCtx.abort,
                deadlineAt:
                  pluginConfig.timeBudget.enabled
                    ? timeBudgetManager.getDeadline(toolCtx.sessionID)
                    : undefined,
                serverUrl: ctx.serverUrl?.toString(),
                architectSessions: runSessions,
                onSessionCreated: async (sessionID) => {
                  if (!runId) {
                    return { ok: false, reason: "run-not-found" as const };
                  }

                  return scopeManager.attachSession(runId, sessionID);
                },
                onRound: (round) => {
                  log.debug("Debate round completed", {
                    round: round.round,
                    approved: round.verdict?.approved,
                    score: round.verdict?.score,
                  });
                },
                onVisibility: emitArchitectVisibility,
                onStatus: emitArchitectStatus,
              });

            if (parsedArgs.value.executionMode === "improvement-audit") {
              let audit: ImprovementAuditOutcome;
              try {
                audit = await runImprovementAudit(ctx.directory, policy);
              } catch (error) {
                log.error("Improvement audit failed", {
                  sessionID: toolCtx.sessionID,
                  error,
                });
                audit = buildSyntheticAuditFailureOutcome(ctx.directory, error);
              }

              if (policy.fallbackMode === "returnPartial" && audit.status !== "healthy") {
                const partial = `## Improvement Audit

Status: ${audit.status}
${audit.summary}`;
                const includeAuditOutput = resolveIncludeAuditOutput(
                  parsedArgs.value.includeAuditOutput,
                  policy.includeAuditOutputDefault,
                );
                return includeAuditOutput
                  ? appendAuditSummary(partial, audit)
                  : partial + "\n\nDebate was skipped due to returnPartial audit mode.";
              }

              const projectContext = await gatherProjectContext(ctx);
              const vision = buildAuditVision(parsedArgs.value.vision, audit);
              const result = await runScopedDebate(vision, projectContext);

              const baseline = formatCondensedResult(
                result.finalDesign,
                result.consensus,
                result.summary,
                result.rounds.length,
                result.transcriptPath,
              );
              const includeAuditOutput = resolveIncludeAuditOutput(
                parsedArgs.value.includeAuditOutput,
                policy.includeAuditOutputDefault,
              );
              if (includeAuditOutput) {
                return appendAuditSummary(baseline, audit);
              }

              if (audit.status !== "healthy") {
                return (
                  `${baseline}` +
                  `\n\n⚠️ Audit status: ${audit.status}. Debate continued with audit findings available only in full logs.`
                );
              }

              return baseline;
            }

            const projectContext = await gatherProjectContext(ctx);
            const result = await runScopedDebate(parsedArgs.value.vision, projectContext);

            return formatCondensedResult(
              result.finalDesign,
              result.consensus,
              result.summary,
              result.rounds.length,
              result.transcriptPath,
            );
          } finally {
            scopeManager.endRun(runId);
          }
        },
      }),

      refactor: tool({
        description:
          "Generate code scaffolding from a design specification, preview changes, and apply them. Supports diff preview and rollback. Can also generate test files.",
        args: {
          design: tool.schema
            .string()
            .describe("The design specification or architecture to generate code from"),
          action: tool.schema
            .enum(["generate", "preview", "apply", "rollback", "list", "generate-tests", "apply-tests"])
            .optional()
            .describe("Action: generate, preview, apply, rollback, list, generate-tests, apply-tests"),
          base_dir: tool.schema
            .string()
            .optional()
            .describe("Base directory for generated files (default: src)"),
          checkpoint_id: tool.schema
            .string()
            .optional()
            .describe("Checkpoint ID for rollback action"),
          generate_tests: tool.schema
            .boolean()
            .optional()
            .describe("Whether to generate test files (default: false)"),
        },
        async execute(args, toolCtx) {
          const engine = new RefactorEngine(ctx.directory, {
            baseDir: args.base_dir || "src",
            autoApply: args.action === "apply",
            createBackup: true,
          });

          // Handle different actions
          switch (args.action) {
            case "generate":
            case "preview": {
              // Generate scaffolding
              const scaffolding = engine.generate(args.design);
              
              // Optionally generate tests
              let testOutput = "";
              if (args.generate_tests) {
                const tests = engine.generateTests(scaffolding);
                if (tests.length > 0) {
                  testOutput = `\n\n### Generated Tests (${tests.length} files)\n\n` +
                    tests.map(t => `- ${t.path}`).join("\n");
                }
              }
              
              // Generate preview
              const preview = await engine.preview(scaffolding);
              
              // Format as markdown
              const previewMd = engine.formatPreviewAsMarkdown(preview);
              
              return `## Code Scaffolding Generated\n\n` +
                `Generated ${scaffolding.files.length} file(s).\n\n` +
                `${previewMd}${testOutput}\n\n` +
                `_To apply these changes, run: refactor with action=apply_\n` +
                `_To generate tests, run: refactor action=generate-tests_`;
            }

            case "apply": {
              // Generate first if not already
              const scaffolding = engine.generate(args.design);
              const preview = await engine.preview(scaffolding);
              
              // Apply changes
              const result = await engine.apply(scaffolding, "Applied from refactor tool");
              
              // Optionally generate and apply tests
              let testResult = "";
              if (args.generate_tests) {
                const tests = engine.generateTests(scaffolding);
                if (tests.length > 0) {
                  const testApplyResult = await engine.applyTests(tests, "Generated from refactor tool");
                  testResult = `\n\n### Test Files\n\n` +
                    `Applied ${testApplyResult.appliedFiles.length} test file(s):\n` +
                    testApplyResult.appliedFiles.map(f => `- ${f}`).join("\n");
                }
              }
              
              if (result.success) {
                return `## ✅ Changes Applied\n\n` +
                  `Applied ${result.appliedFiles.length} file(s).\n\n` +
                  result.appliedFiles.map(f => `- ${f}`).join("\n") +
                  `${testResult}\n\n_Rollback available with checkpoint ID: ${result.checkpointId}_`;
              } else {
                return `## ⚠️ Partial Success\n\n` +
                  `Applied ${result.appliedFiles.length} file(s) with ${result.errors.length} error(s):\n\n` +
                  result.errors.map(e => `- ${e}`).join("\n") +
                  testResult;
              }
            }

            case "rollback": {
              if (!args.checkpoint_id) {
                // Quick rollback to last checkpoint
                const result = await engine.quickRollback();
                
                if (result.success) {
                  return `## ✅ Rollback Complete\n\n` +
                    `Restored ${result.restoredFiles.length} file(s).`;
                } else {
                  return `## ❌ Rollback Failed\n\n` +
                    result.errors.join("\n");
                }
              } else {
                const result = await engine.rollback(args.checkpoint_id);
                
                if (result.success) {
                  return `## ✅ Rollback Complete\n\n` +
                    `Restored ${result.restoredFiles.length} file(s) from checkpoint.`;
                } else {
                  return `## ❌ Rollback Failed\n\n` +
                    result.errors.join("\n");
                }
              }
            }

            case "list": {
              const checkpoints = engine.listCheckpoints();
              
              if (checkpoints.length === 0) {
                return "## Checkpoints\n\nNo checkpoints available.";
              }
              
              const list = checkpoints.map(cp => 
                `- **${new Date(cp.timestamp).toLocaleString()}**: ${cp.description} (${cp.files.length} files)`
              ).join("\n");
              
              return `## Available Checkpoints\n\n${list}`;
            }

            case "generate-tests": {
              // Generate scaffolding first
              const scaffolding = engine.generate(args.design);
              
              // Generate tests
              const tests = engine.generateTests(scaffolding);
              
              if (tests.length === 0) {
                return "## Test Scaffolding\n\nNo test files could be generated (no TypeScript/JavaScript files found).";
              }
              
              const testList = tests.map(t => `### ${t.path}\n\n\`\`\`typescript\n${t.content}\n\`\`\``).join("\n\n");
              
              return `## Test Scaffolding Generated\n\n` +
                `Generated ${tests.length} test file(s).\n\n` +
                `${testList}\n\n` +
                `_To apply these test files, run: refactor action=apply-tests_`;
            }

            case "apply-tests": {
              // Generate scaffolding first
              const scaffolding = engine.generate(args.design);
              
              // Generate tests
              const tests = engine.generateTests(scaffolding);
              
              // Apply tests
              const result = await engine.applyTests(tests, "Generated from refactor tool");
              
              if (result.success) {
                return `## ✅ Test Files Applied\n\n` +
                  `Applied ${result.appliedFiles.length} test file(s).\n\n` +
                  result.appliedFiles.map(f => `- ${f}`).join("\n");
              } else {
                return `## ⚠️ Partial Success\n\n` +
                  `Applied ${result.appliedFiles.length} test file(s) with ${result.errors.length} error(s):\n\n` +
                  result.errors.map(e => `- ${e}`).join("\n");
              }
            }

            default: {
              // Default: generate and preview
              const scaffolding = engine.generate(args.design);
              const preview = await engine.preview(scaffolding);
              return engine.formatPreviewAsMarkdown(preview);
            }
          }
        },
      }),
    },
  };
};

export default EffectiveOpencodePlugin;
