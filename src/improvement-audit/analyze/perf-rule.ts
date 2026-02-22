import type { ImprovementCandidate, ProjectSnapshot } from "../types";
import { createContextLogger } from "../../logger";
import { readSnapshotFileHead } from "../snapshot";

const log = createContextLogger("audit-performance-rule");

const PERF_PATTERNS: Array<{
  pattern: RegExp;
  title: string;
  summary: string;
  suggestion: string;
  severity: ImprovementCandidate["severity"];
}> = [
  {
    pattern: /for\s*\([^;]+;[^;]+;[^)]*\)\s*\{[\s\S]{0,1800}?\s*for\s*\(/,
    title: "Nested loop hotspot",
    summary: "A nested loop pattern was detected.",
    suggestion: "Review algorithmic complexity and consider map/set joins or indexes if dataset growth is expected.",
    severity: "medium",
  },
  {
    pattern: /for\s*\([^;]+;[^;]+;[^)]*\)\s*\{[\s\S]{0,1200}?await\s+/,
    title: "Sequential awaits in loop",
    summary: "Await appears inside a loop.",
    suggestion: "Use Promise.all with mapped promises when ordering does not depend on iteration state.",
    severity: "medium",
  },
  {
    pattern: /JSON\.parse\(await\s+fs\.promises\.readFile\([^\)]*\)\)|await\s+fs\.promises\.readFile\([^\)]*\)\s*\)\s*\)/,
    title: "I/O parsing in loop",
    summary: "Potential repeated JSON parsing after each read.",
    suggestion: "Cache parsed content where possible and avoid reparsing the same file repeatedly.",
    severity: "low",
  },
];

function createCandidate(
  file: string,
  rule: (typeof PERF_PATTERNS)[number],
  evidence: string,
): ImprovementCandidate {
  return {
    id: `perf-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    area: "performance",
    title: `${rule.title}: ${file}`,
    summary: rule.summary,
    severity: rule.severity,
    suggestion: rule.suggestion,
    evidence,
  };
}

export async function analyzePerformanceRules(
  snapshot: ProjectSnapshot,
  maxFilesToRead: number,
): Promise<ImprovementCandidate[]> {
  const files = snapshot.files
    .filter((entry) => entry.relativePath.toLowerCase().match(/\.(ts|tsx|js|jsx|mjs|cjs)$/))
    .slice(0, maxFilesToRead);

  const findings: ImprovementCandidate[] = [];

  await Promise.all(
    files.map(async (file) => {
      const content = await readSnapshotFileHead(file.path, 60_000);
      if (!content) return;

      for (const rule of PERF_PATTERNS) {
        if (!rule.pattern.test(content)) continue;
        const match = content.match(rule.pattern);
        const evidence = match?.[0] ? `"${match[0]}"` : "Pattern match";
        findings.push(createCandidate(file.relativePath, rule, evidence));
        break;
      }
    }),
  );

  log.debug("Performance rule analysis completed", {
    filesScanned: files.length,
    findings: findings.length,
  });

  return findings;
}
