import type {
  AppLevelImprovementAuditPolicy,
  AuditHealth,
  AuditProfile,
  FallbackMode,
  ResolvedImprovementAuditPolicy,
  ParsedArchitectArgs,
  ImprovementAuditPolicy,
  AnalyzerStatus,
} from "./types";

const DEFAULT_AUDIT_POLICY: ImprovementAuditPolicy = {
  profile: "safe",
  globalTimeoutMs: 120_000,
  perAnalyzerTimeoutMs: 15_000,
  perAnalyzerMaxFileReads: 20,
  maxFindingsPerAnalyzer: 3,
  globalMaxFindings: 12,
  maxEvidenceChars: 1_200,
  maxRoundsCap: 8,
  fallbackMode: "runDebate",
  includeAuditOutputDefault: false,
  enabledAnalyzers: ["context-rule", "security-rule", "perf-rule"],
};

const PROFILE_OVERRIDES: Record<
  AuditProfile,
  Partial<ImprovementAuditPolicy>
> = {
  safe: {
    perAnalyzerTimeoutMs: 10_000,
    maxFindingsPerAnalyzer: 2,
    globalMaxFindings: 8,
    maxRoundsCap: 5,
    enabledAnalyzers: ["context-rule", "security-rule"],
  },
  default: {
    perAnalyzerTimeoutMs: 15_000,
    maxFindingsPerAnalyzer: 3,
    globalMaxFindings: 12,
    maxRoundsCap: 8,
  },
  aggressive: {
    perAnalyzerTimeoutMs: 25_000,
    perAnalyzerMaxFileReads: 50,
    maxFindingsPerAnalyzer: 6,
    globalMaxFindings: 24,
    maxRoundsCap: 12,
    enabledAnalyzers: ["context-rule", "security-rule", "perf-rule"],
  },
};

function clampInt(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  const next = Math.round(value);
  if (next < min || next > max) return fallback;
  return next;
}

function normalizeEnabledAnalyzers(
  analyzers: unknown,
): string[] {
  if (!Array.isArray(analyzers)) return ["context-rule", "security-rule", "perf-rule"];
  const cleaned = analyzers
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return cleaned.length ? cleaned : ["context-rule", "security-rule", "perf-rule"];
}

function normalizeFallbackMode(raw: unknown): FallbackMode {
  return raw === "returnPartial" ? "returnPartial" : "runDebate";
}

export function getDefaultAuditPolicy(): ImprovementAuditPolicy {
  return { ...DEFAULT_AUDIT_POLICY, enabledAnalyzers: [...DEFAULT_AUDIT_POLICY.enabledAnalyzers] };
}

export function resolveExecutionPolicy(
  appPolicy: AppLevelImprovementAuditPolicy | undefined,
  args: Pick<
    ParsedArchitectArgs,
    "maxRounds" | "maxFindings" | "includeAuditOutput" | "auditProfile"
  >,
): ResolvedImprovementAuditPolicy {
  const profile: AuditProfile =
    args.auditProfile ?? appPolicy?.profile ?? DEFAULT_AUDIT_POLICY.profile;

  const baseline = {
    ...DEFAULT_AUDIT_POLICY,
    ...appPolicy,
    ...PROFILE_OVERRIDES[profile],
  };

  const resolved: ImprovementAuditPolicy = {
    ...baseline,
    profile,
    globalTimeoutMs: clampInt(
      Number(appPolicy?.globalTimeoutMs ?? DEFAULT_AUDIT_POLICY.globalTimeoutMs),
      10_000,
      600_000,
      DEFAULT_AUDIT_POLICY.globalTimeoutMs,
    ),
    perAnalyzerTimeoutMs: clampInt(
      Number(appPolicy?.perAnalyzerTimeoutMs ?? baseline.perAnalyzerTimeoutMs),
      5_000,
      60_000,
      baseline.perAnalyzerTimeoutMs,
    ),
    perAnalyzerMaxFileReads: clampInt(
      Number(appPolicy?.perAnalyzerMaxFileReads ?? baseline.perAnalyzerMaxFileReads),
      1,
      200,
      baseline.perAnalyzerMaxFileReads,
    ),
    maxFindingsPerAnalyzer: clampInt(
      Number(appPolicy?.maxFindingsPerAnalyzer ?? baseline.maxFindingsPerAnalyzer),
      1,
      25,
      baseline.maxFindingsPerAnalyzer,
    ),
    globalMaxFindings: clampInt(
      Number(appPolicy?.globalMaxFindings ?? baseline.globalMaxFindings),
      1,
      100,
      baseline.globalMaxFindings,
    ),
    maxEvidenceChars: clampInt(
      Number(appPolicy?.maxEvidenceChars ?? baseline.maxEvidenceChars),
      100,
      5_000,
      baseline.maxEvidenceChars,
    ),
    maxRoundsCap: clampInt(
      Number(appPolicy?.maxRoundsCap ?? baseline.maxRoundsCap),
      1,
      24,
      baseline.maxRoundsCap,
    ),
    fallbackMode: normalizeFallbackMode(appPolicy?.fallbackMode),
    includeAuditOutputDefault:
      typeof appPolicy?.includeAuditOutputDefault === "boolean"
        ? appPolicy.includeAuditOutputDefault
        : DEFAULT_AUDIT_POLICY.includeAuditOutputDefault,
    enabledAnalyzers: normalizeEnabledAnalyzers(appPolicy?.enabledAnalyzers),
  };

  const resolvedProfile: ResolvedImprovementAuditPolicy = {
    ...resolved,
    source: {
      defaults: getDefaultAuditPolicy(),
      appConfig: appPolicy ?? {},
      toolArgs: {
        maxRounds:
          typeof args.maxRounds === "undefined" ? "__unset__" : args.maxRounds,
        maxFindings:
          typeof args.maxFindings === "undefined" ? "__unset__" : args.maxFindings,
        includeAuditOutput:
          typeof args.includeAuditOutput === "undefined" ? "__unset__" : args.includeAuditOutput,
        auditProfile: args.auditProfile,
      },
    },
  };

  if (typeof args.maxRounds === "number") {
    resolvedProfile.maxRoundsCap = clampInt(args.maxRounds, 1, 24, resolvedProfile.maxRoundsCap);
  }
  if (typeof args.maxFindings === "number") {
    resolvedProfile.globalMaxFindings = clampInt(
      args.maxFindings,
      1,
      100,
      resolvedProfile.globalMaxFindings,
    );
  }
  if (typeof args.includeAuditOutput === "boolean") {
    resolvedProfile.includeAuditOutputDefault = args.includeAuditOutput;
  }

  return {
    ...resolvedProfile,
  };
}

export function classifyHealth(
  outcomes: { status: AnalyzerStatus }[],
): AuditHealth {
  if (outcomes.some((entry) => entry.status === "failed")) return "failed";
  if (outcomes.some((entry) => entry.status === "degraded")) return "degraded";
  return "healthy";
}
