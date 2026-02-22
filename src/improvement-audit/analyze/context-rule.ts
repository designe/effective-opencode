import { createContextLogger } from "../../logger";
import type { ImprovementCandidate, ProjectSnapshot } from "../types";

const log = createContextLogger("audit-context-rule");

function candidate(
  area: string,
  title: string,
  summary: string,
  suggestion: string,
  severity: ImprovementCandidate["severity"] = "low",
): ImprovementCandidate {
  return {
    id: `context-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    area,
    title,
    summary,
    severity,
    suggestion,
  };
}

export function analyzeContextRules(snapshot: ProjectSnapshot): ImprovementCandidate[] {
  const files = snapshot.files.map((f) => f.relativePath.toLowerCase());
  const hasReadme = files.some((f) => f.endsWith("readme.md") || f.endsWith("readme"));
  const hasPackageJson = files.includes("package.json");
  const hasTests = files.some((file) => file.includes("test") || file.includes("spec"));
  const srcFiles = files.filter((file) => file.startsWith("src/"));

  const findings: ImprovementCandidate[] = [];

  if (!hasReadme) {
    findings.push(
      candidate(
        "project-ops",
        "Missing README",
        "No README file was detected in the scanned project snapshot.",
        "Add a README that explains setup, architecture assumptions, and decision rationale.",
        "low",
      ),
    );
  }

  if (!hasPackageJson) {
    findings.push(
      candidate(
        "build",
        "Missing package.json",
        "No package manifest was found, reducing tooling and dependency visibility.",
        "Ensure a manifest exists and tracks scripts/dependencies for reproducibility.",
        "medium",
      ),
    );
  }

  if (srcFiles.length === 0) {
    findings.push(
      candidate(
        "structure",
        "No src tree",
        "No files were detected under src/, so architecture guidance may miss core implementation context.",
        "Prioritize a src entry directory and include key feature folders there.",
        "low",
      ),
    );
  }

  if (!hasTests) {
    findings.push(
      candidate(
        "testing",
        "No obvious test files",
        "Snapshot did not include any test-like file names.",
        "Create a baseline test scaffold to prevent regressions from architecture changes.",
        "medium",
      ),
    );
  }

  log.debug("Context rule completed", { findings: findings.length, fileCount: snapshot.files.length });
  return findings;
}
