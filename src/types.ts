// ============================================================================
// Re-export types from @opencode-ai/plugin and @opencode-ai/sdk
// ============================================================================

export type { Plugin, PluginInput } from "@opencode-ai/plugin";
export type { OpencodeClient, Message, Part, TextPart } from "@opencode-ai/sdk";
import type { TimeBudgetConfig } from "./time-budget/types";

// ============================================================================
// Model Configuration
// ============================================================================

export interface ModelConfig {
  providerID: string;
  modelID: string;
}

/**
 * Parse a "provider/model" string into ModelConfig.
 * e.g. "anthropic/claude-sonnet-4-20250514" → { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" }
 */
export function parseModelString(model: string): ModelConfig {
  const slashIdx = model.indexOf("/");
  if (slashIdx === -1) {
    return { providerID: model, modelID: model };
  }
  return {
    providerID: model.slice(0, slashIdx),
    modelID: model.slice(slashIdx + 1),
  };
}

/**
 * Format ModelConfig back to "provider/model" string.
 */
export function formatModelString(model: ModelConfig): string {
  return `${model.providerID}/${model.modelID}`;
}

// ============================================================================
// Plugin Configuration
// ============================================================================

export interface PluginConfig {
  maxRounds: number;
  retainSessions: boolean;
  timeoutMs: number;
  timeBudget: TimeBudgetConfig;
  proposerPersona?: string;
  criticPersona?: string;
  /** Model for proposer architect, e.g. "anthropic/claude-sonnet-4-20250514" */
  proposerModel?: string;
  /** Model for critic architect, e.g. "google/gemini-2.5-pro" */
  criticModel?: string;
  /** Captured lead model to use as primary fallback */
  leadModel?: string;
}

export interface EffectiveOpencodeConfigBlock {
  improvementAudit?: import("./improvement-audit/types").AppLevelImprovementAuditPolicy;
  timeBudget?: Partial<TimeBudgetConfig>;
  [key: string]: unknown;
}

export interface ArchitectPluginConfigBlock {
  maxRounds?: number;
  retainSessions?: boolean;
  timeoutMs?: number;
  proposerPersona?: string;
  criticPersona?: string;
  proposerModel?: string;
  criticModel?: string;
  leadModel?: string;
  improvementAudit?: import("./improvement-audit/types").AppLevelImprovementAuditPolicy;
  timeBudget?: Partial<TimeBudgetConfig>;
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: PluginConfig = {
  maxRounds: 3,
  retainSessions: false,
  timeoutMs: 300_000,
  timeBudget: {
    enabled: true,
    finalizingThreshold: 0.95,
    compactSoftThreshold: 0.65,
    compactHardThreshold: 0.82,
    compactCooldownMs: 600_000,
    compactProgressCheckpoints: [0.5, 0.85],
    timerChunkMs: 60 * 60 * 1000,
  },
};

export const FALLBACK_MODELS = [
  "google/gemini-2.5-pro",
  "google/gemini-2.0-flash",
  "anthropic/claude-3-5-sonnet-20241022",
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
];

// ============================================================================
// Debate Protocol Types
// ============================================================================

export interface Verdict {
  approved: boolean;
  score: number;
  key_issues: string[];
}

export interface DialogueRound {
  round: number;
  proposal: string;
  critique: string;
  verdict: Verdict | null;
}

export type DebateAgent = "proposer" | "critic";

export type DebateVisibilityKind =
  | "setup"
  | "thinking"
  | "round_result"
  | "consensus"
  | "failure"
  | "cancelled"
  | "complete";

export interface DebateVisibilityEvent {
  kind: DebateVisibilityKind;
  round?: number;
  agent?: DebateAgent;
  message: string;
  variant?: "info" | "success" | "warning" | "error";
}

export interface ProtocolResult {
  rounds: DialogueRound[];
  finalDesign: string;
  consensus: boolean;
  summary: string;
  transcriptPath?: string;
}

// ============================================================================
// Plugin Hooks Types
// ============================================================================

/**
 * Tool execution event payload for event hook
 */
export interface ToolExecuteEventPayload {
  type: "tool.execute.after" | "tool.execute.before";
  payload?: {
    tool: string;
    args?: {
      filePath?: string;
      command?: string;
      [key: string]: unknown;
    };
  };
}

/**
 * Input for tool.execute.before/after hooks
 */
export interface ToolExecuteInput {
  tool: string;
  sessionID: string;
  callID?: string;
  args?: Record<string, unknown>;
}

/**
 * Output for tool.execute.before/after hooks
 */
export interface ToolExecuteOutput {
  args?: Record<string, unknown>;
}

/**
 * System transform hook output
 */
export interface SystemTransformOutput {
  system: string[];
}

/**
 * Application configuration from opencode.json
 */
export interface AppConfig {
  effectiveOpencode?: Partial<PluginConfig> & EffectiveOpencodeConfigBlock;
  architectPlugin?: Partial<PluginConfig> & ArchitectPluginConfigBlock;
  [key: string]: unknown;
}
