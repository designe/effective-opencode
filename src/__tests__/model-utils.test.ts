import { describe, expect, test } from "bun:test";
import { resolveLeadModel } from "../model-utils";

describe("model-utils", () => {
  describe("resolveLeadModel", () => {
    test("should use provider + id", () => {
      expect(resolveLeadModel({ provider: "openai", id: "gpt-4o" })).toBe(
        "openai/gpt-4o",
      );
    });

    test("should support providerID + modelID shape", () => {
      expect(
        resolveLeadModel({ providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" }),
      ).toBe("anthropic/claude-3-5-sonnet-20241022");
    });

    test("should keep already-qualified id", () => {
      expect(resolveLeadModel({ id: "openai/gpt-4o" })).toBe("openai/gpt-4o");
    });

    test("should not infer provider when id is unqualified", () => {
      expect(resolveLeadModel({ id: "gpt-5" })).toBeUndefined();
      expect(resolveLeadModel({ id: "claude-sonnet-4" })).toBeUndefined();
    });

    test("should return undefined when unresolvable", () => {
      expect(resolveLeadModel({ id: "some-unknown-model" })).toBeUndefined();
      expect(resolveLeadModel({ provider: "openai" })).toBeUndefined();
      expect(resolveLeadModel(null)).toBeUndefined();
    });
  });
});
