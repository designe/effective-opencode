import { describe, test, expect } from "bun:test";
import { parseVerdict, detectConsensus, assessCritiqueQuality } from "../consensus";

describe("parseVerdict", () => {
  test("should parse valid JSON verdict block", () => {
    const response = `
Here is my analysis...

\`\`\`json:verdict
{ "approved": true, "score": 8, "key_issues": ["minor: consider caching"] }
\`\`\`
    `;

    const verdict = parseVerdict(response);

    expect(verdict).not.toBeNull();
    expect(verdict?.approved).toBe(true);
    expect(verdict?.score).toBe(8);
    expect(verdict?.key_issues).toHaveLength(1);
    expect(verdict?.key_issues[0]).toBe("minor: consider caching");
  });

  test("should parse not approved verdict", () => {
    const response = `
\`\`\`json:verdict
{ "approved": false, "score": 4, "key_issues": ["missing error handling", "no tests"] }
\`\`\`
    `;

    const verdict = parseVerdict(response);

    expect(verdict).not.toBeNull();
    expect(verdict?.approved).toBe(false);
    expect(verdict?.score).toBe(4);
    expect(verdict?.key_issues).toHaveLength(2);
  });

  test("should use keyword fallback when JSON is malformed", () => {
    const response = `APPROVED: this design is solid after careful consideration.`;

    const verdict = parseVerdict(response);

    expect(verdict).not.toBeNull();
    expect(verdict?.approved).toBe(true);
    expect(verdict?.score).toBe(8);
  });

  test("should return null for no verdict", () => {
    const response = `
This is just regular text without any verdict.
    `;

    const verdict = parseVerdict(response);

    expect(verdict).toBeNull();
  });

  test("should handle empty key_issues", () => {
    const response = `
\`\`\`json:verdict
{ "approved": true, "score": 10, "key_issues": [] }
\`\`\`
    `;

    const verdict = parseVerdict(response);

    expect(verdict).not.toBeNull();
    expect(verdict?.key_issues).toHaveLength(0);
  });

  test("should handle malformed JSON gracefully", () => {
    const response = `
\`\`\`json:verdict
{ "approved": true, "score": not_a_number }
\`\`\`
    `;

    const verdict = parseVerdict(response);

    expect(verdict).toBeNull();
  });
});

describe("detectConsensus", () => {
  test("should detect consensus when approved and score >= 7", () => {
    const response = `
\`\`\`json:verdict
{ "approved": true, "score": 8, "key_issues": [] }
\`\`\`
    `;

    const result = detectConsensus(response);

    expect(result.reached).toBe(true);
    expect(result.summary).toContain("Approved");
    expect(result.summary).toContain("8/10");
  });

  test("should not detect consensus when not approved", () => {
    const response = `
\`\`\`json:verdict
{ "approved": false, "score": 8, "key_issues": ["needs work"] }
\`\`\`
    `;

    const result = detectConsensus(response);

    expect(result.reached).toBe(false);
    expect(result.summary).toBe("");
  });

  test("should not detect consensus when score < 7", () => {
    const response = `
\`\`\`json:verdict
{ "approved": true, "score": 6, "key_issues": [] }
\`\`\`
    `;

    const result = detectConsensus(response);

    expect(result.reached).toBe(false);
  });

  test("should include key issues in summary", () => {
    const response = `
\`\`\`json:verdict
{ "approved": true, "score": 7, "key_issues": ["minor issue"] }
\`\`\`
    `;

    const result = detectConsensus(response);

    expect(result.reached).toBe(true);
    expect(result.summary).toContain("minor issue");
  });
});

describe("assessCritiqueQuality", () => {
  test("flags placeholder responses", () => {
    const quality = assessCritiqueQuality("Planning detailed architecture design");
    expect(quality.ok).toBe(false);
    expect(quality.reason).toBe("placeholder_response");
  });

  test("flags responses without verdict", () => {
    const quality = assessCritiqueQuality("Concrete critique but no verdict block");
    expect(quality.ok).toBe(false);
    expect(quality.reason).toBe("missing_verdict");
  });

  test("accepts valid critique with verdict", () => {
    const quality = assessCritiqueQuality(
      [
        "Strengths: clear module boundaries.",
        "Weaknesses: retry policy is underspecified.",
        "```json:verdict",
        '{ "approved": false, "score": 6, "key_issues": ["define retry backoff"] }',
        "```",
      ].join("\n"),
    );
    expect(quality.ok).toBe(true);
  });
});
