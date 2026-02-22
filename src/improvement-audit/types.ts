export type ExecutionMode = "debate" | "improvement-audit";

export type AuditProfile = "safe" | "default" | "aggressive";

export type FallbackMode = "runDebate" | "returnPartial";

export type AnalyzerStatus = "ok" | "degraded" | "failed";

export type AuditHealth = "healthy" | "degraded" | "failed";

export type FindingSeverity = "low" | "medium" | "high";

export interface ImprovementCandidate {
  id: string;
  area: string;
  title: string;
  summary: string;
  severity: FindingSeverity;
  suggestion: string;
  evidence?: string;
}

export interface ImprovementAuditPolicy {
  profile: AuditProfile;
  globalTimeoutMs: number;
  perAnalyzerTimeoutMs: number;
  perAnalyzerMaxFileReads: number;
  maxFindingsPerAnalyzer: number;
  globalMaxFindings: number;
  maxEvidenceChars: number;
  maxRoundsCap: number;
  fallbackMode: FallbackMode;
  includeAuditOutputDefault: boolean;
  enabledAnalyzers: string[];
}

export type AppLevelImprovementAuditPolicy = Partial<ImprovementAuditPolicy>;

export interface RawArchitectArgs {
  vision?: unknown;
  execution_mode?: unknown;
  max_rounds?: unknown;
  max_findings?: unknown;
  include_audit_output?: unknown;
  audit_profile?: unknown;
}

export interface ParsedArchitectArgs {
  vision: string;
  executionMode: ExecutionMode;
  maxRounds?: number;
  maxFindings?: number;
  includeAuditOutput?: boolean;
  auditProfile: AuditProfile;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface SnapshotFileMeta {
  path: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  inode?: number;
}

export interface ProjectSnapshot {
  projectRoot: string;
  generatedAt: number;
  files: SnapshotFileMeta[];
}

export interface AnalyzerExecutionOutcome {
  name: string;
  status: AnalyzerStatus;
  findings: ImprovementCandidate[];
  durationMs: number;
  error?: string;
}

export interface ImprovementAuditOutcome {
  status: AuditHealth;
  findings: ImprovementCandidate[];
  summary: string;
  auditRunId: string;
  analyzerOutcomes: AnalyzerExecutionOutcome[];
  snapshot: ProjectSnapshot;
}

export interface ResolvedImprovementAuditPolicy extends ImprovementAuditPolicy {
  source: {
    defaults: ImprovementAuditPolicy;
    appConfig: AppLevelImprovementAuditPolicy;
    toolArgs: {
      maxRounds: number | "__unset__";
      maxFindings: number | "__unset__";
      includeAuditOutput: boolean | "__unset__";
      auditProfile: AuditProfile;
    };
  };
}
