import { buildAuditSummaryBlock } from "./prompt";
import type { ImprovementAuditOutcome } from "./types";

export function appendAuditSummary(baseResult: string, audit: ImprovementAuditOutcome): string {
  const summary = buildAuditSummaryBlock(audit);
  return `${baseResult}\n\n${summary}`;
}
