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
import { gatherProjectContext } from "./context";
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
import { ContextAwareSkillLoader } from "./skills/index";

// Refactoring Engine
import { RefactorEngine } from "./refactor/index";

const log = createContextLogger("plugin");

export const EffectiveOpencodePlugin: Plugin = async (ctx: PluginInput) => {
  let pluginConfig: PluginConfig = { ...DEFAULT_CONFIG };
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
  const architectSessions = new Set<string>();

  // 4. Track app-configured audit policy blocks by precedence source.
  let appAuditConfig: AppLevelImprovementAuditPolicy | undefined;
  let legacyAuditConfig: AppLevelImprovementAuditPolicy | undefined;

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
            edit: "allow",
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
      const isArchitect = scopeManager.isKnownSession(input.sessionID);
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
        if (sessionID && permissionID && scopeManager.isKnownSession(sessionID)) {
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
      const typedEvent = event as ToolExecuteEventPayload | null;
      if (typedEvent?.type === "tool.execute.after" && typedEvent.payload) {
        const { tool: toolName, args } = typedEvent.payload;
        if (
          ["read", "write", "edit"].includes(toolName) &&
          args?.filePath
        ) {
          recentContext.add(args.filePath);
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

      const activeSkills = skillLoader.getActiveSkills(
        Array.from(recentContext),
      );

      for (const skill of activeSkills) {
        output.system.push(
          `## Project Context Skill: ${skill.name}\n${skill.description}\n\n${skill.instructions}`,
        );
      }
    },

    "chat.message": async (
      input: {
        sessionID: string;
        agent?: string;
        model?: { providerID?: string; modelID?: string; id?: string; provider?: string };
      },
      _output: { message: unknown; parts: unknown[] },
    ) => {
      if (input.model) {
        updateLeadModel(input.model, "chat.message");
      }
    },

    // 5. Intercept Executions for Content-Hashing Security
    "tool.execute.before": async (
      input: ToolExecuteInput,
      output: ToolExecuteOutput,
    ) => {
      const { tool: toolName } = input;
      const args = input.args ?? output.args;
      if (toolName === "bash" && args && typeof args.command === "string") {
        const cmdParts = args.command.split(" ");
        if (cmdParts.length > 0) {
          await authEngine.verifyAndAuthorize(
            "bash_execution",
            cmdParts[0],
            cmdParts.slice(1),
            ctx.directory,
          );
        }
      }
    },

    tool: {
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
          try {
            runId = scopeManager.startRun(toolCtx.sessionID, architectSessions);
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
                serverUrl: ctx.serverUrl?.toString(),
                architectSessions,
                onRound: (round) => {
                  setMetaTitle(
                    `Architects: Round ${round.round}/${config.maxRounds} ${
                      round.verdict?.approved ? "(consensus!)" : ""
                    }`,
                  );
                },
                onStatus: (status) => {
                  setMetaTitle(`Architects: ${status}`);
                },
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
              serverUrl: ctx.serverUrl?.toString(),
              architectSessions,
              onRound: (round) => {
                setMetaTitle(
                  `Architects: Round ${round.round}/${config.maxRounds} ${
                    round.verdict?.approved ? "(consensus!)" : ""
                  }`,
                );
              },
              onStatus: (status) => {
                setMetaTitle(`Architects: ${status}`);
              },
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
