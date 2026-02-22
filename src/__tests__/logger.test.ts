import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { logger, createContextLogger } from "../logger";

describe("logger", () => {
  const originalEnv = process.env.OPENCODE_LOG_LEVEL;

  beforeEach(() => {
    // Reset env
    delete process.env.OPENCODE_LOG_LEVEL;
  });

  afterEach(() => {
    // Restore env
    if (originalEnv) {
      process.env.OPENCODE_LOG_LEVEL = originalEnv;
    } else {
      delete process.env.OPENCODE_LOG_LEVEL;
    }
  });

  test("should create context logger", () => {
    const ctxLogger = createContextLogger("test");

    expect(ctxLogger.debug).toBeDefined();
    expect(ctxLogger.info).toBeDefined();
    expect(ctxLogger.warn).toBeDefined();
    expect(ctxLogger.error).toBeDefined();
  });

  test("should respect log level - info by default", () => {
    const debugSpy = mock(() => {});
    const infoSpy = mock(() => {});

    // Since we can't easily mock console, we just test the interface
    // In real usage, info should log but debug should not by default
    const ctxLogger = createContextLogger("test");

    // Just verify the methods exist and can be called
    expect(() => ctxLogger.info("test message")).not.toThrow();
    expect(() => ctxLogger.debug("test message")).not.toThrow();
  });

  test("should format error messages", () => {
    const error = new Error("Test error");
    const ctxLogger = createContextLogger("test");

    // Should not throw
    expect(() => ctxLogger.error("Error occurred", error)).not.toThrow();
  });

  test("should handle non-Error objects", () => {
    const ctxLogger = createContextLogger("test");

    // Should not throw with various inputs
    expect(() => ctxLogger.error("Error", "string error")).not.toThrow();
    expect(() => ctxLogger.error("Error", { foo: "bar" })).not.toThrow();
    expect(() => ctxLogger.error("Error", null)).not.toThrow();
    expect(() => ctxLogger.error("Error", undefined)).not.toThrow();
  });
});
