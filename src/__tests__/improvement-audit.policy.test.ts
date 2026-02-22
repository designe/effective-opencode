import { describe, expect, test } from "bun:test";

import type { ParsedArchitectArgs } from "../improvement-audit/types";
import { resolveExecutionPolicy } from "../improvement-audit/policy";

describe("resolveExecutionPolicy", () => {
  test("builds baseline policy for debate mode", () => {
    const parsed: ParsedArchitectArgs = {
      vision: "Refactor config flow",
      executionMode: "debate",
      auditProfile: "safe",
    };

    const policy = resolveExecutionPolicy(undefined, {
      maxRounds: parsed.maxRounds,
      maxFindings: parsed.maxFindings,
      includeAuditOutput: parsed.includeAuditOutput,
      auditProfile: parsed.auditProfile,
    });

    expect(policy.profile).toBe("safe");
    expect(policy.globalMaxFindings).toBeGreaterThan(0);
    expect(policy.maxRoundsCap).toBeGreaterThan(0);
  });

  test("applies app policy and strict argument overrides", () => {
    const appPolicy = {
      profile: "aggressive" as const,
      globalMaxFindings: 5,
      includeAuditOutputDefault: true,
      fallbackMode: "returnPartial" as const,
    };

    const parsed: ParsedArchitectArgs = {
      vision: "Use aggressive audit profile",
      executionMode: "improvement-audit",
      auditProfile: "aggressive",
      maxFindings: 50,
      maxRounds: 4,
      includeAuditOutput: true,
    };

    const policy = resolveExecutionPolicy(appPolicy, {
      maxRounds: parsed.maxRounds,
      maxFindings: parsed.maxFindings,
      includeAuditOutput: parsed.includeAuditOutput,
      auditProfile: parsed.auditProfile,
    });

    expect(policy.fallbackMode).toBe("returnPartial");
    expect(policy.profile).toBe("aggressive");
    expect(policy.includeAuditOutputDefault).toBeTrue();
    expect(policy.globalMaxFindings).toBe(50);
  });
});
