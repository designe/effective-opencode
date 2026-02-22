import type { ImprovementAuditOutcome, ImprovementCandidate } from "./types";

function formatCandidate(candidate: ImprovementCandidate): string {
  return [
    `- [${candidate.severity.toUpperCase()}] ${candidate.area}: ${candidate.title}`,
    `  - Summary: ${candidate.summary}`,
    `  - Suggestion: ${candidate.suggestion}`,
  ].join("\n");
}

export function buildAuditVision(vision: string, audit: ImprovementAuditOutcome): string {
  const findings = audit.findings.length
    ? audit.findings.map((finding) => formatCandidate(finding)).join("\n")
    : "- No major findings detected in the automatic scan.";

  return `${vision}

## Improvement Audit Context
This session runs in improvement-audit mode.
Status: ${audit.status}

Findings to consider first:
${findings}`;
}

export function buildAuditSummaryBlock(audit: ImprovementAuditOutcome): string {
  const top = audit.findings
    .slice(0, 6)
    .map((finding) => `- [${finding.severity.toUpperCase()}] ${finding.title}`)
    .join("\n");

  return [
    "## Improvement Audit Summary",
    `Status: ${audit.status}`,
    `Total findings: ${audit.findings.length}`,
    "Top findings:",
    top || "- None",
  ].join("\n");
}
