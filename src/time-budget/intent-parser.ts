export type TimeBudgetIntentAction = "decline" | "approve" | "numeric-only" | "none";

export interface TimeBudgetIntentMatch {
  hasNumeric: boolean;
  hasDecline: boolean;
  hasApproval: boolean;
  action: TimeBudgetIntentAction;
}

const NUMERIC_TIME_EXPRESSION =
  /(?:\d+(?:\.\d+)?\s*(?:h|hr|hrs|hour|hours|min|mins|minute|minutes|sec|secs|second|seconds))|(?:\d+(?:\.\d+)?\s*(?:시간|분|초))/i;

const DURATION_TOKEN_EXPRESSION =
  /(\d+(?:\.\d+)?)\s*(시간|h|hr|hrs|hour|hours|분|min|mins|minute|minutes|초|sec|secs|second|seconds)/gi;

const TIME_BUDGET_DECLINE_EXPRESSION =
  /(?:\bno\b|\bnope\b|\bwithout\b|\bskip\b|\bdon't\b|\bdo not\b|아니|괜찮|시간\s*제한\s*없이|타임\s*버짓\s*없이|제한\s*없이)/i;

const TIME_BUDGET_APPROVAL_EXPRESSION =
  /(?:\byes\b|\bok\b|\bokay\b|\bsure\b|\bgo ahead\b|strict\s+deadline|deadline\s+mode|strict\s+mode|엄격\s*모드|엄격\s*시간|네\b|응\b|맞아)/i;

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

export const extractTimeBudgetMinutes = (value: string): number | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;

  let totalMinutes = 0;
  let matched = false;
  for (const match of value.matchAll(DURATION_TOKEN_EXPRESSION)) {
    const amountRaw = match[1];
    const unitRaw = (match[2] ?? "").toLowerCase();
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    matched = true;

    if (["h", "hr", "hrs", "hour", "hours", "시간"].includes(unitRaw)) {
      totalMinutes += amount * 60;
      continue;
    }

    if (["min", "mins", "minute", "minutes", "분"].includes(unitRaw)) {
      totalMinutes += amount;
      continue;
    }

    if (["sec", "secs", "second", "seconds", "초"].includes(unitRaw)) {
      totalMinutes += amount / 60;
    }
  }

  if (!matched) return undefined;
  const rounded = Math.ceil(totalMinutes);
  return rounded >= 1 ? rounded : 1;
};
