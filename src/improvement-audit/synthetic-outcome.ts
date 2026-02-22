import type { ImprovementAuditOutcome, AnalyzerExecutionOutcome, ProjectSnapshot } from "./types";

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "unknown error";
  }
  return String(error);
}

export function buildSyntheticAuditFailureOutcome(
  projectRoot: string,
  error: unknown,
): ImprovementAuditOutcome {
  const message = normalizeError(error);
  const analyzerOutcomes: AnalyzerExecutionOutcome[] = [
    {
      name: "audit-orchestrator",
      status: "failed",
      findings: [],
      error: message,
      durationMs: 0,
    },
  ];

  const snapshot: ProjectSnapshot = {
    projectRoot,
    generatedAt: Date.now(),
    files: [],
  };

  return {
    status: "failed",
    findings: [],
    summary: `Improvement audit failed: ${message}`,
    auditRunId: `synthetic-${Date.now()}`,
    analyzerOutcomes,
    snapshot,
  };
}
