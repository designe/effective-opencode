import { describe, test, expect } from "bun:test";
import {
  parseModelString,
  formatModelString,
  DEFAULT_CONFIG,
} from "../types";
import type { ModelConfig, PluginConfig } from "../types";

describe("ModelConfig", () => {
  describe("parseModelString", () => {
    test("should parse provider/model format", () => {
      const result = parseModelString("anthropic/claude-sonnet-4-20250514");

      expect(result.providerID).toBe("anthropic");
      expect(result.modelID).toBe("claude-sonnet-4-20250514");
    });

    test("should parse google/gemini format", () => {
      const result = parseModelString("google/gemini-2.5-pro");

      expect(result.providerID).toBe("google");
      expect(result.modelID).toBe("gemini-2.5-pro");
    });

    test("should handle model string with multiple slashes", () => {
      const result = parseModelString("openai/gpt-4o/preview");

      expect(result.providerID).toBe("openai");
      expect(result.modelID).toBe("gpt-4o/preview");
    });

    test("should handle model string without slash", () => {
      const result = parseModelString("claude-sonnet-4-20250514");

      expect(result.providerID).toBe("claude-sonnet-4-20250514");
      expect(result.modelID).toBe("claude-sonnet-4-20250514");
    });

    test("should handle empty string", () => {
      const result = parseModelString("");

      expect(result.providerID).toBe("");
      expect(result.modelID).toBe("");
    });
  });

  describe("formatModelString", () => {
    test("should format ModelConfig to provider/model string", () => {
      const model: ModelConfig = {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
      };

      expect(formatModelString(model)).toBe("anthropic/claude-sonnet-4-20250514");
    });

    test("should roundtrip with parseModelString", () => {
      const original = "google/gemini-2.5-pro";
      const parsed = parseModelString(original);
      const formatted = formatModelString(parsed);

      expect(formatted).toBe(original);
    });
  });

  describe("DEFAULT_CONFIG", () => {
    test("should have expected defaults", () => {
      expect(DEFAULT_CONFIG.maxRounds).toBe(3);
      expect(DEFAULT_CONFIG.retainSessions).toBe(false);
      expect(DEFAULT_CONFIG.timeoutMs).toBe(300_000);
      expect(DEFAULT_CONFIG.debateMode).toBe("sequential");
    });

    test("should not force model overrides by default", () => {
      expect(DEFAULT_CONFIG.proposerModel).toBeUndefined();
      expect(DEFAULT_CONFIG.criticModel).toBeUndefined();
    });
  });

  describe("PluginConfig model fields", () => {
    test("should accept model configuration", () => {
      const config: PluginConfig = {
        ...DEFAULT_CONFIG,
        debateMode: "parallel",
        proposerModel: "anthropic/claude-sonnet-4-20250514",
        criticModel: "google/gemini-2.5-pro",
      };

      expect(config.debateMode).toBe("parallel");
      expect(config.proposerModel).toBe("anthropic/claude-sonnet-4-20250514");
      expect(config.criticModel).toBe("google/gemini-2.5-pro");
    });

    test("should allow overriding default models", () => {
      const config: PluginConfig = {
        ...DEFAULT_CONFIG,
        proposerModel: "openai/gpt-4o",
        criticModel: "anthropic/claude-sonnet-4-20250514",
      };

      expect(config.proposerModel).toBe("openai/gpt-4o");
      expect(config.criticModel).toBe("anthropic/claude-sonnet-4-20250514");
    });
  });
});
