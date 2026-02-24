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
  const sessionModelContextLimit = new Map<string, number>();

  const hasNumericTimeExpression = (value: string): boolean => {
    return /(?:\d+(?:\.\d+)?\s*(?:h|hr|hrs|hour|hours|min|mins|minute|minutes|sec|secs|second|seconds))|(?:\d+(?:\.\d+)?\s*(?:시간|분|초))/i.test(
      value,
    );
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

  const applyTimeBudgetOverrides = (source: unknown) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return;
    const tb = (source as { timeBudget?: unknown }).timeBudget;
    if (!tb || typeof tb !== "object" || Array.isArray(tb)) return;
    const candidate = tb as Record<string, unknown>;
    if (typeof candidate.enabled === "boolean") {
      pluginConfig.timeBudget.enabled = candidate.enabled;
    }
    if (
      typeof candidate.finalizingThreshold === "number" &&
      Number.isFinite(candidate.finalizingThreshold) &&
      candidate.finalizingThreshold > 0 &&
      candidate.finalizingThreshold <= 1
    ) {
      pluginConfig.timeBudget.finalizingThreshold = candidate.finalizingThreshold;
    }
    if (
      typeof candidate.compactSoftThreshold === "number" &&
      Number.isFinite(candidate.compactSoftThreshold) &&
      candidate.compactSoftThreshold > 0 &&
      candidate.compactSoftThreshold <= 1
    ) {
      pluginConfig.timeBudget.compactSoftThreshold = candidate.compactSoftThreshold;
    }
    if (
      typeof candidate.compactHardThreshold === "number" &&
      Number.isFinite(candidate.compactHardThreshold) &&
      candidate.compactHardThreshold > 0 &&
      candidate.compactHardThreshold <= 1
    ) {
      pluginConfig.timeBudget.compactHardThreshold = candidate.compactHardThreshold;
    }
    if (
      typeof candidate.compactCooldownMs === "number" &&
      Number.isFinite(candidate.compactCooldownMs) &&
      candidate.compactCooldownMs > 0
    ) {
      pluginConfig.timeBudget.compactCooldownMs = Math.floor(candidate.compactCooldownMs);
    }
    if (
      typeof candidate.timerChunkMs === "number" &&
      Number.isFinite(candidate.timerChunkMs) &&
      candidate.timerChunkMs > 0
    ) {
      pluginConfig.timeBudget.timerChunkMs = Math.floor(candidate.timerChunkMs);
    }
    if (Array.isArray(candidate.compactProgressCheckpoints)) {
      const parsed = candidate.compactProgressCheckpoints
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        .filter((value) => value > 0 && value <= 1)
        .sort((a, b) => a - b);
      if (parsed.length > 0) {
        pluginConfig.timeBudget.compactProgressCheckpoints = [...new Set(parsed)];
      }
    }
  };

  const timeBudgetManager = new TimeBudgetManager({
    config: pluginConfig.timeBudget,
    onExpired: async (sessionID: string) => {
      log.warn("Time budget expired; aborting active session", { sessionID });
      await ctx.client.session.abort({ path: { id: sessionID } }).catch((error: unknown) => {
        log.warn("Failed to abort session on time-budget expiration", { sessionID, error });
      });
      timeBudgetManager.clearBudget(sessionID);
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

      // ── Inject "architect" agent with full permissions ─────────────
      // This is the approach used by oh-my-opencode-slim:
      // Instead of intercepting permission.ask at runtime (unreliable for
      // API-created sub-sessions), define an agent in the opencode config
      // that has all permissions pre-granted. Sessions prompted with
      // `agent: "architect"` inherit these permissions automatically.
      const cfg = appConfig as Record<string, unknown>;
      if (!cfg.agent || typeof cfg.agent !== "object") {
        cfg.agent = {};
      }
      const agents = cfg.agent as Record<string, unknown>;
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

      // Track recently accessed files for conditional skill loading
      if (e?.type === "session.idle" && e.properties) {
        const props = e.properties as { sessionID?: string };
        if (props.sessionID) {
          timeBudgetManager.clearBudget(props.sessionID);
          pendingTimeIntentSessions.delete(props.sessionID);
          sessionModelContextLimit.delete(props.sessionID);
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
        const contextLimit = (input.model as { limit?: { context?: number } } | undefined)?.limit
          ?.context;
        if (typeof contextLimit === "number" && contextLimit > 0) {
          sessionModelContextLimit.set(input.sessionID, contextLimit);
        }

        const hasPendingIntent = pendingTimeIntentSessions.has(input.sessionID);
        const snapshot = timeBudgetManager.getSnapshot(input.sessionID);
        if (hasPendingIntent && !snapshot) {
          output.system.push(`
## Time Budget Confirmation Required

The user appears to have requested a time-constrained execution window.
Before doing the main work, explicitly confirm the proposed duration with the user using this pattern:
"I will work for ~X minutes/hours under a strict deadline. Should I start now?"

If the user confirms, immediately call the tool \
\`start_time_budget\`\
 with the approved duration in minutes, then proceed.
`);
        }

        if (snapshot) {
          const remaining = formatDuration(snapshot.remainingMs);
          const elapsedPct = Math.round(snapshot.elapsedRatio * 100);
          const isFinalizing = snapshot.elapsedRatio >= pluginConfig.timeBudget.finalizingThreshold;
          output.system.push(`
## Active Time Budget

- Remaining: ${remaining}
- Elapsed: ${elapsedPct}%
- Deadline mode: strict

Execution policy:
- Do not expand scope unless critical.
- Prioritize completion and correctness over optional polish.
- If budget is nearly exhausted, finish with a concise status + remaining risks.
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
      if (input.model) {
        updateLeadModel(input.model, "chat.message");
      }

      if (!pluginConfig.timeBudget.enabled) return;

      if (input.sessionID) {
        timeBudgetManager.clearBudget(input.sessionID);
        sessionModelContextLimit.delete(input.sessionID);
      }

      const text = extractTextFromParts(output.parts);
      if (input.sessionID && hasNumericTimeExpression(text)) {
        pendingTimeIntentSessions.add(input.sessionID);
      } else if (input.sessionID) {
        pendingTimeIntentSessions.delete(input.sessionID);
      }
    },

    // 5. Intercept Executions for Content-Hashing Security
    "tool.execute.before": async (
      input: ToolExecuteInput,
      output: ToolExecuteOutput,
    ) => {
      const { tool: toolName } = input;
      const args = input.args ?? output.args;
      if (
        pluginConfig.timeBudget.enabled &&
        input.sessionID &&
        toolName !== "start_time_budget" &&
        timeBudgetManager.shouldBlockTools(input.sessionID)
      ) {
        const snapshot = timeBudgetManager.getSnapshot(input.sessionID);
        if (snapshot?.remainingMs && snapshot.remainingMs <= 0) {
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

          const durationMs = Math.floor(minutes * 60_000);
          const state = timeBudgetManager.startBudget(toolCtx.sessionID, durationMs);
          pendingTimeIntentSessions.delete(toolCtx.sessionID);
          toolCtx.metadata({
            title: `Time budget active: ${Math.round(minutes)} minute(s)`,
          });

          return (
            `Time budget started for ${Math.round(minutes)} minute(s). ` +
            `Remaining window: ${formatDuration(state.deadlineAt - Date.now())}.`
          );
        },
      }),

      architect: tool({
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
          // Guard against recursive architect invocations from architect
          // sub-sessions. These sessions are intended to respond to prompts,
          // not to spawn nested debate loops.
          if (scopeManager.isKnownSession(toolCtx.sessionID)) {
            log.warn("Blocked recursive architect invocation from architect sub-session", {
              sessionID: toolCtx.sessionID,
            });
            return "Architect sub-sessions cannot invoke the architect tool recursively. Continuing current debate flow.";
          }

          const parsedArgs = parseArchitectArgs(args);
          if (!parsedArgs.ok) {
            return `Invalid architect args: ${parsedArgs.error}`;
          }
          
          let runId: string | undefined;
          let runSessions: Set<string>;
          try {
            runSessions = new Set<string>();
            runId = scopeManager.startRun(toolCtx.sessionID);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `Cannot start architect run: ${message}`;
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
          const emitArchitectVisibility = (
            event: {
              kind: string;
              message: string;
              variant?: "info" | "success" | "warning" | "error";
            },
          ) => {
            emitArchitectStatus(event.message, {
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

            ctx.client.tui
              .showToast({
                body: {
                  title: "Architects",
                  message,
                  variant: options?.variant ?? "info",
                  duration: 2200,
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
                const includeAuditOutput =
                  typeof parsedArgs.value.includeAuditOutput === "boolean"
                    ? parsedArgs.value.includeAuditOutput
                    : policy.includeAuditOutputDefault;
                return includeAuditOutput
                  ? appendAuditSummary(partial, audit)
                  : partial + "\n\nDebate was skipped due to returnPartial audit mode.";
              }

              const projectContext = await gatherProjectContext(ctx);
              const vision = buildAuditVision(parsedArgs.value.vision, audit);
              const result = await runDebate(ctx.client, ctx, {
                parentSessionID: toolCtx.sessionID,
                vision,
                projectContext,
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

              const baseline = formatCondensedResult(
                result.finalDesign,
                result.consensus,
                result.summary,
                result.rounds.length,
                result.transcriptPath,
              );
              const includeAuditOutput =
                typeof parsedArgs.value.includeAuditOutput === "boolean"
                  ? parsedArgs.value.includeAuditOutput
                  : policy.includeAuditOutputDefault;
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
            const result = await runDebate(ctx.client, ctx, {
              parentSessionID: toolCtx.sessionID,
              vision: parsedArgs.value.vision,
              projectContext,
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
