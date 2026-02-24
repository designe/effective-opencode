import type { Verdict } from "./types";
import { createContextLogger } from "./logger";

const log = createContextLogger("consensus");

const PLACEHOLDER_PATTERNS = [
  "planning detailed architecture design",
  "drafting detailed revised proposal",
  "finalizing revised design response",
  "placeholder",
];

export function assessCritiqueQuality(response: string): {
  ok: boolean;
  reason?: "empty_response" | "placeholder_response" | "missing_verdict";
} {
  const trimmed = response.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty_response" };
  }

  const normalized = trimmed.toLowerCase();
  if (PLACEHOLDER_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return { ok: false, reason: "placeholder_response" };
  }

  if (!parseVerdict(trimmed)) {
    return { ok: false, reason: "missing_verdict" };
  }

  return { ok: true };
}

/**
 * Parse a structured verdict from an architect's response.
 * Primary: ```json:verdict fenced block.
 * Fallback: APPROVED: keyword pattern.
 */
export function parseVerdict(response: string): Verdict | null {
  // Primary: structured json:verdict fenced block
  const jsonMatch = response.match(/```json:verdict\s*\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const verdict: Verdict = {
        approved: !!parsed.approved,
        score: typeof parsed.score === "number" ? parsed.score : 0,
        key_issues: Array.isArray(parsed.key_issues) ? parsed.key_issues : [],
      };
      log.debug("Parsed verdict from JSON block", verdict);
      return verdict;
    } catch (e) {
      log.warn("Failed to parse JSON verdict block", e);
      // Malformed JSON — fall through to keyword check
    }
  }

  // Fallback: keyword detection
  const keywordMatch = response.match(/^APPROVED:\s*(.+)$/m);
  if (keywordMatch) {
    log.debug("Using keyword fallback for verdict detection");
    return { approved: true, score: 8, key_issues: [] };
  }

  log.debug("No verdict found in response");
  return null;
}

/**
 * Check if the critic's verdict indicates consensus.
 * Requires both approved: true AND score >= 7 as a safety net.
 */
export function detectConsensus(criticResponse: string): {
  reached: boolean;
  summary: string;
} {
  const verdict = parseVerdict(criticResponse);
  if (verdict && verdict.approved && verdict.score >= 7) {
    const summary = `Approved (score: ${verdict.score}/10)${
      verdict.key_issues.length
        ? ` — minor: ${verdict.key_issues.join(", ")}`
        : ""
    }`;
    log.info("Consensus reached", { score: verdict.score, issues: verdict.key_issues });
    return { reached: true, summary };
  }
  log.debug("No consensus", { verdict });
  return { reached: false, summary: "" };
}
