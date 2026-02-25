import { describe, expect, test } from "bun:test";
import {
  extractTimeBudgetMinutes,
  resolveTimeBudgetIntent,
} from "../time-budget/intent-parser";

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
      "응, 엄격 모드로 진행",
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

  test("does not treat generic positive requests as strict approval", () => {
    expect(resolveTimeBudgetIntent("좋아, 그냥 계속 진행해줘").hasApproval).toBe(false);
    expect(resolveTimeBudgetIntent("해줘").hasApproval).toBe(false);
  });

  test("extracts minutes from common Korean/English expressions", () => {
    expect(extractTimeBudgetMinutes("7분동안 프로젝트 검토해줘")).toBe(7);
    expect(extractTimeBudgetMinutes("1.5 hours only")).toBe(90);
    expect(extractTimeBudgetMinutes("45초만 확인")).toBe(1);
    expect(extractTimeBudgetMinutes("2시간 30분 안에")).toBe(150);
  });
});
