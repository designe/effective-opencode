export type TimeBudgetIntentAction = "decline" | "approve" | "numeric-only" | "none";

export interface TimeBudgetIntentMatch {
  hasNumeric: boolean;
  hasDecline: boolean;
  hasApproval: boolean;
  action: TimeBudgetIntentAction;
}

const NUMERIC_TIME_EXPRESSION =
  /(?:\d+(?:\.\d+)?\s*(?:h|hr|hrs|hour|hours|min|mins|minute|minutes|sec|secs|second|seconds))|(?:\d+(?:\.\d+)?\s*(?:시간|분|초))/i;

const TIME_BUDGET_DECLINE_EXPRESSION =
  /(?:\bno\b|\bnope\b|\bwithout\b|\bskip\b|\bdon't\b|\bdo not\b|아니|괜찮|시간\s*제한\s*없이|타임\s*버짓\s*없이|제한\s*없이)/i;

const TIME_BUDGET_APPROVAL_EXPRESSION =
  /(?:\byes\b|\bok\b|\bokay\b|\bsure\b|\bgo ahead\b|strict\s+deadline|deadline\s+mode|엄격\s*모드|엄격\s*시간|네\b|응\b|좋아|진행해|해줘|해 주세요|해줘요|맞아)/i;

export const resolveTimeBudgetIntent = (value: string): TimeBudgetIntentMatch => {
  const hasNumeric = NUMERIC_TIME_EXPRESSION.test(value);
  const hasDecline = TIME_BUDGET_DECLINE_EXPRESSION.test(value);
  const hasApproval = TIME_BUDGET_APPROVAL_EXPRESSION.test(value);

  if (hasDecline) {
    return { hasNumeric, hasDecline, hasApproval, action: "decline" };
  }

  if (hasApproval) {
    return { hasNumeric, hasDecline, hasApproval, action: "approve" };
  }

  if (hasNumeric) {
    return { hasNumeric, hasDecline, hasApproval, action: "numeric-only" };
  }

  return { hasNumeric, hasDecline, hasApproval, action: "none" };
};
