import { describe, expect, test } from "bun:test";

import { buildSyntheticAuditFailureOutcome } from "../improvement-audit/synthetic-outcome";

describe("buildSyntheticAuditFailureOutcome", () => {
  test("creates a typed failed audit outcome", () => {
    const outcome = buildSyntheticAuditFailureOutcome("/tmp/project", new Error("boom"));

    expect(outcome.status).toBe("failed");
    expect(outcome.auditRunId).toContain("synthetic-");
    expect(outcome.summary).toContain("audit failed");
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.analyzerOutcomes).toHaveLength(1);
    expect(outcome.analyzerOutcomes[0]).toMatchObject({
      name: "audit-orchestrator",
      status: "failed",
      error: "boom",
      findings: [],
    });
    expect(outcome.snapshot).toMatchObject({
      projectRoot: "/tmp/project",
      files: [],
    });
  });
});
