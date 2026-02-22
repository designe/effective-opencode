import type { ImprovementCandidate, ProjectSnapshot } from "../types";
import { createContextLogger } from "../../logger";
import { readSnapshotFileHead } from "../snapshot";

const log = createContextLogger("audit-security-rule");

const SUSPICIOUS_PATTERNS: Array<{
  pattern: RegExp;
  title: string;
  summary: string;
  suggestion: string;
  severity: ImprovementCandidate["severity"];
}> = [
  {
    pattern: /(?:^|[^a-zA-Z])eval\s*\(/,
    title: "Potential dynamic code execution",
    summary: "Detected use of eval().",
    suggestion: "Avoid eval() and validate required dynamic behavior with safer parsing alternatives.",
    severity: "high",
  },
  {
    pattern: /new\s+Function\s*\(/,
    title: "Dynamic Function construction",
    summary: "Detected new Function() usage.",
    suggestion: "Avoid dynamic function constructors and prefer explicit call paths.",
    severity: "high",
  },
  {
    pattern: /child_process|spawn\s*\(|exec\s*\(|execSync\s*\(/,
    title: "Process execution risk",
    summary: "Potential shell command execution in application code.",
    suggestion: "Validate and strictly sanitize command inputs before process execution.",
    severity: "high",
  },
  {
    pattern: /bash\s*`|\$\(cmd\)|`\s*\$\{/,
    title: "Command construction",
    summary: "Command-like string interpolation may be present.",
    suggestion: "Use argument arrays with execFile, and avoid shell interpolation.",
    severity: "medium",
  },
];

function createCandidate(
  file: string,
  rule: (typeof SUSPICIOUS_PATTERNS)[number],
  evidence: string,
): ImprovementCandidate {
  return {
    id: `security-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    area: "security",
    title: `${rule.title}: ${file}`,
    summary: rule.summary,
    severity: rule.severity,
    suggestion: rule.suggestion,
    evidence,
  };
}

export async function analyzeSecurityRules(
  snapshot: ProjectSnapshot,
  maxFilesToRead: number,
): Promise<ImprovementCandidate[]> {
  const files = snapshot.files
    .filter((entry) => entry.relativePath.toLowerCase().match(/\.(ts|tsx|js|jsx|mjs|cjs)$/))
    .slice(0, maxFilesToRead);

  const findings: ImprovementCandidate[] = [];

  await Promise.all(
    files.map(async (file) => {
      const content = await readSnapshotFileHead(file.path, 40_000);
      if (!content) return;

      for (const rule of SUSPICIOUS_PATTERNS) {
        if (!rule.pattern.test(content)) continue;
        const match = content.match(rule.pattern);
        const evidence = match?.[0] ? `"${match[0]}"` : "Pattern match";
        findings.push(createCandidate(file.relativePath, rule, evidence));
        break;
      }
    }),
  );

  log.debug("Security rule analysis completed", {
    filesScanned: files.length,
    findings: findings.length,
  });

  return findings;
}
