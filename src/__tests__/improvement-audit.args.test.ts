import { describe, expect, test } from "bun:test";

import { parseArchitectArgs } from "../improvement-audit/args";

describe("parseArchitectArgs", () => {
  test("accepts legacy debate args", () => {
    const result = parseArchitectArgs({ vision: "Improve the auth flow" });

    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.value.executionMode).toBe("debate");
      expect(result.value.vision).toBe("Improve the auth flow");
      expect(result.value.auditProfile).toBe("safe");
    }
  });

  test("accepts improvement-audit args", () => {
    const result = parseArchitectArgs({
      vision: "Audit and improve architecture",
      execution_mode: "improvement-audit",
      max_rounds: 5,
      max_findings: 24,
      include_audit_output: true,
      audit_profile: "aggressive",
    });

    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.value.executionMode).toBe("improvement-audit");
      expect(result.value.maxRounds).toBe(5);
      expect(result.value.maxFindings).toBe(24);
      expect(result.value.includeAuditOutput).toBeTrue();
      expect(result.value.auditProfile).toBe("aggressive");
    }
  });

  test("rejects unknown execution mode", () => {
    const result = parseArchitectArgs({
      vision: "Bad mode test",
      execution_mode: "simulate",
    });

    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error).toContain("execution_mode must be one of");
    }
  });

  test("rejects malformed max_findings", () => {
    const result = parseArchitectArgs({
      vision: "Bounds test",
      max_findings: 0,
    });

    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error).toContain("max_findings must be within");
    }
  });
});
