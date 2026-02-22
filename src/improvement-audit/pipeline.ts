import { classifyHealth } from "./policy";
import {
  analyzeContextRules,
  analyzePerformanceRules,
  analyzeSecurityRules,
} from "./analyze/index";
import { collectProjectSnapshot } from "./snapshot";
import type {
  AnalyzerExecutionOutcome,
  ResolvedImprovementAuditPolicy,
  ImprovementAuditOutcome,
  ImprovementCandidate,
} from "./types";

type AnalyzerName = "context-rule" | "security-rule" | "perf-rule";

const ALLOWED_ANALYZERS: ReadonlyArray<AnalyzerName> = [
  "context-rule",
  "security-rule",
  "perf-rule",
];

const ANALYZER_SEVERITY_RANK: Record<"low" | "medium" | "high", number> = {
  high: 100,
  medium: 50,
  low: 10,
};

async function runWithTimeout(
  name: AnalyzerName,
  run: () => Promise<ImprovementCandidate[]>,
  timeoutMs: number,
): Promise<AnalyzerExecutionOutcome> {
  const started = Date.now();
  try {
    const result = await Promise.race([
      run(),
      new Promise<ImprovementCandidate[]>((_, reject) =>
        setTimeout(() => reject(new Error(`${name} timed out`)), timeoutMs),
      ),
    ]);
    return {
      name,
      status: result.length > 0 ? "ok" : "ok",
      findings: result,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("timed out") ? "degraded" : "failed";
    return {
      name,
      status,
      findings: [],
      durationMs: Date.now() - started,
      error: msg,
    };
  }
}

function normalizeEvidence(candidate: ImprovementCandidate, maxEvidenceChars: number): ImprovementCandidate {
  const evidence = candidate.evidence;
  if (!evidence || evidence.length <= maxEvidenceChars) {
    return candidate;
  }
  return {
    ...candidate,
    evidence: evidence.slice(0, Math.max(0, maxEvidenceChars)),
  };
}

function limitFindings(
  findings: ImprovementCandidate[],
  maxCount: number,
): ImprovementCandidate[] {
  return findings.slice(0, maxCount);
}

function sortFindings(findings: ImprovementCandidate[]): ImprovementCandidate[] {
  return findings.slice().sort((a, b) => {
    if (a.severity !== b.severity) {
      return ANALYZER_SEVERITY_RANK[b.severity] - ANALYZER_SEVERITY_RANK[a.severity];
    }
    const area = a.area.localeCompare(b.area);
    if (area !== 0) return area;
    const title = a.title.localeCompare(b.title);
    if (title !== 0) return title;
    const summary = a.summary.localeCompare(b.summary);
    if (summary !== 0) return summary;
    const evidence = (a.evidence ?? "").localeCompare(b.evidence ?? "");
    if (evidence !== 0) return evidence;
    return a.id.localeCompare(b.id);
  });
}

function uniqueEnabledAnalyzers(input: unknown[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of input) {
    const normalized = typeof name === "string" ? name.trim() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

export async function runImprovementAudit(
  projectRoot: string,
  policy: ResolvedImprovementAuditPolicy,
): Promise<ImprovementAuditOutcome> {
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const snapshot = await collectProjectSnapshot(projectRoot, {
    maxDepth: 6,
    maxFiles: Math.max(policy.globalMaxFindings * 8, 60),
  });

  const analyzers: Record<AnalyzerName, () => Promise<ImprovementCandidate[]>> = {
    "context-rule": async () => analyzeContextRules(snapshot),
    "security-rule": () =>
      analyzeSecurityRules(
        snapshot,
        Math.max(3, Math.floor(policy.perAnalyzerMaxFileReads / 2)),
      ),
    "perf-rule": () =>
      analyzePerformanceRules(
        snapshot,
        Math.max(3, Math.floor(policy.perAnalyzerMaxFileReads / 3)),
      ),
  };

  const uniqueNames = uniqueEnabledAnalyzers(policy.enabledAnalyzers);
  const selected = uniqueNames.filter((name) =>
    ALLOWED_ANALYZERS.includes(name as AnalyzerName),
  ) as AnalyzerName[];
  const unknown = uniqueNames.filter((name) => !ALLOWED_ANALYZERS.includes(name as AnalyzerName));

  const unknownOutcomes: AnalyzerExecutionOutcome[] = unknown.map((name) => ({
    name,
    status: "failed",
    findings: [],
    error: `Unknown analyzer: ${name}`,
    durationMs: 0,
  }));

  const globalStart = Date.now();
  const outcomes: AnalyzerExecutionOutcome[] = [];

  for (const name of selected) {
    const elapsedGlobal = Date.now() - globalStart;
    const remainingGlobal = Math.max(0, policy.globalTimeoutMs - elapsedGlobal);
    if (remainingGlobal <= 0) {
      outcomes.push({
        name,
        status: "degraded",
        findings: [],
        error: "Global audit timeout exhausted",
        durationMs: 0,
      });
      continue;
    }

    const perAnalyzerTimeout = Math.min(policy.perAnalyzerTimeoutMs, remainingGlobal);
    outcomes.push(await runWithTimeout(name, analyzers[name], perAnalyzerTimeout));
  }

  outcomes.push(...unknownOutcomes);

  const rankedFindings: ImprovementCandidate[] = [];
  for (const outcome of outcomes) {
    const capped = limitFindings(
      outcome.findings,
      policy.maxFindingsPerAnalyzer,
    );
    rankedFindings.push(...capped.map((item) => normalizeEvidence(item, policy.maxEvidenceChars)));
  }

  const sorted = sortFindings(rankedFindings);

  const findings = sorted.slice(0, policy.globalMaxFindings);

  const health = classifyHealth(outcomes);
  return {
    status: health,
    findings,
    summary: `Analyzed ${snapshot.files.length} files using ${selected.length} analyzer(s).`,
    auditRunId: runId,
    analyzerOutcomes: outcomes,
    snapshot,
  };
}
