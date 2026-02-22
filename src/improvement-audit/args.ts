import type {
  AuditProfile,
  ExecutionMode,
  ParsedArchitectArgs,
  ParseResult,
  RawArchitectArgs,
} from "./types";

function asUnknownObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parseVision(raw: unknown): ParseResult<string> {
  if (typeof raw !== "string") {
    return { ok: false, error: "vision must be a string" };
  }
  if (!raw.trim()) {
    return { ok: false, error: "vision must not be empty" };
  }
  return { ok: true, value: raw };
}

function parseExecutionMode(raw: unknown): ParseResult<ExecutionMode> {
  if (raw === undefined) return { ok: true, value: "debate" };
  if (raw === "debate" || raw === "improvement-audit") {
    return { ok: true, value: raw };
  }
  return {
    ok: false,
    error: "execution_mode must be one of: debate, improvement-audit",
  };
}

function parsePositiveFiniteInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): ParseResult<number> {
  if (raw === undefined) {
    return { ok: false, error: "__unset__" };
  }

  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return { ok: false, error: `${field} must be a finite integer` };
  }

  if (raw < min || raw > max) {
    return {
      ok: false,
      error: `${field} must be within ${min} and ${max}`,
    };
  }

  return { ok: true, value: raw };
}

function parseStrictBoolean(raw: unknown, field: string): ParseResult<boolean> {
  if (raw === undefined) return { ok: false, error: "__unset__" };
  if (typeof raw !== "boolean") {
    return { ok: false, error: `${field} must be true or false` };
  }
  return { ok: true, value: raw };
}

function parseAuditProfile(raw: unknown, fallback: AuditProfile): ParseResult<AuditProfile> {
  if (raw === undefined) return { ok: true, value: fallback };
  if (raw === "safe" || raw === "default" || raw === "aggressive") {
    return { ok: true, value: raw };
  }
  return {
    ok: false,
    error: "audit_profile must be one of: safe, default, aggressive",
  };
}

export function parseArchitectArgs(raw: unknown): ParseResult<ParsedArchitectArgs> {
  const parsed = asUnknownObject(raw);
  if (!parsed) {
    return { ok: false, error: "Arguments must be an object" };
  }

  const normalized = parsed as RawArchitectArgs;

  const vision = parseVision(normalized.vision);
  if (!vision.ok) {
    return { ok: false, error: vision.error };
  }

  const executionMode = parseExecutionMode(normalized.execution_mode);
  if (!executionMode.ok) {
    return { ok: false, error: executionMode.error };
  }

  const maxRounds = parsePositiveFiniteInt(normalized.max_rounds, "max_rounds", 1, 50);
  const maxFindings = parsePositiveFiniteInt(normalized.max_findings, "max_findings", 1, 1000);
  const includeAuditOutput = parseStrictBoolean(
    normalized.include_audit_output,
    "include_audit_output",
  );
  if (!maxRounds.ok && !isUnsetResult(maxRounds)) {
    return maxRounds;
  }
  if (!maxFindings.ok && !isUnsetResult(maxFindings)) {
    return maxFindings;
  }
  if (!includeAuditOutput.ok && !isUnsetResult(includeAuditOutput)) {
    return includeAuditOutput;
  }

  const auditProfile = parseAuditProfile(
    normalized.audit_profile,
    executionMode.value === "improvement-audit" ? "default" : "safe",
  );
  if (!auditProfile.ok) {
    return { ok: false, error: auditProfile.error };
  }

  const value: ParsedArchitectArgs = {
    vision: vision.value!,
    executionMode: executionMode.value!,
    auditProfile: auditProfile.value!,
  };

  if (maxRounds.ok) {
    value.maxRounds = maxRounds.value!;
  }
  if (maxFindings.ok) {
    value.maxFindings = maxFindings.value!;
  }
  if (includeAuditOutput.ok) {
    value.includeAuditOutput = includeAuditOutput.value!;
  }

  return { ok: true, value };
}

export function isUnsetResult(result: ParseResult<unknown>): boolean {
  return result.ok === false && result.error === "__unset__";
}
