import { describe, expect, test } from "bun:test";
import { resolveTimeBudgetIntent } from "../time-budget/intent-parser";

describe("time budget intent parser", () => {
  test("keeps compatibility for numeric intent fixtures", () => {
    const fixtures = [
      "10분 동안 리팩토링해줘",
      "30 minutes please",
      "2h deadline",
      "45초만 확인해줘",
    ];

    for (const text of fixtures) {
      const result = resolveTimeBudgetIntent(text);
      expect(result.hasNumeric).toBe(true);
    }
  });

  test("keeps compatibility for approval fixtures", () => {
    const fixtures = [
      "yes, go ahead",
      "strict deadline mode",
      "응, 진행해줘",
      "네 엄격 모드로 해줘",
    ];

    for (const text of fixtures) {
      const result = resolveTimeBudgetIntent(text);
      expect(result.hasApproval).toBe(true);
    }
  });

  test("keeps compatibility for decline fixtures", () => {
    const fixtures = [
      "no, continue without it",
      "skip strict mode",
      "아니, 제한 없이 진행해줘",
      "시간 제한 없이 해줘",
    ];

    for (const text of fixtures) {
      const result = resolveTimeBudgetIntent(text);
      expect(result.hasDecline).toBe(true);
    }
  });

  test("uses precedence decline > approval > numeric-only", () => {
    expect(resolveTimeBudgetIntent("yes but no strict mode for 10 minutes").action).toBe("decline");
    expect(resolveTimeBudgetIntent("10분으로 엄격 모드 진행해줘").action).toBe("approve");
    expect(resolveTimeBudgetIntent("15 minutes").action).toBe("numeric-only");
  });
});
