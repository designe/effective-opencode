import { describe, expect, test } from "bun:test";
import { TimeBudgetManager } from "../time-budget/manager";
import type { TimeBudgetConfig } from "../time-budget/types";

const config: TimeBudgetConfig = {
  enabled: true,
  finalizingThreshold: 0.95,
  compactSoftThreshold: 0.65,
  compactHardThreshold: 0.82,
  compactCooldownMs: 10_000,
  compactProgressCheckpoints: [0.5, 0.85],
  timerChunkMs: 5_000,
};

describe("TimeBudgetManager", () => {
  test("starts a budget and returns snapshot", () => {
    const manager = new TimeBudgetManager({
      config,
      onExpired: () => {},
    });

    const now = Date.now();
    manager.startBudget("s1", 120_000, now);
    const snapshot = manager.getSnapshot("s1", now + 30_000);

    expect(snapshot).toBeDefined();
    expect(snapshot?.remainingMs).toBe(90_000);
    expect(snapshot?.elapsedRatio).toBe(0.25);
    expect(manager.shouldBlockTools("s1", now + 30_000)).toBeFalse();
    manager.clearBudget("s1");
  });

  test("blocks tools at finalizing threshold", () => {
    const manager = new TimeBudgetManager({
      config,
      onExpired: () => {},
    });
    const now = Date.now();
    manager.startBudget("s2", 100_000, now);

    expect(manager.shouldBlockTools("s2", now + 95_000)).toBeTrue();
    manager.clearBudget("s2");
  });

  test("fires expiration callback when already expired", async () => {
    let expiredSession = "";
    const manager = new TimeBudgetManager({
      config,
      onExpired: (sessionID) => {
        expiredSession = sessionID;
      },
    });

    manager.startBudget("s3", 60_000, Date.now() - 61_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(expiredSession).toBe("s3");
    manager.clearBudget("s3");
  });

  test("returns hard-threshold compact decision immediately", () => {
    const manager = new TimeBudgetManager({
      config,
      onExpired: () => {},
    });

    const now = Date.now();
    manager.startBudget("s4", 120_000, now);
    const decision = manager.evaluateCompact("s4", 0.9, now + 10_000);

    expect(decision.shouldCompact).toBeTrue();
    expect(decision.reason).toBe("hard-threshold");
    manager.clearBudget("s4");
  });

  test("respects compact cooldown for soft threshold", () => {
    const manager = new TimeBudgetManager({
      config,
      onExpired: () => {},
    });

    const now = Date.now();
    manager.startBudget("s5", 120_000, now);
    manager.markCompacted("s5", now);

    const decision = manager.evaluateCompact("s5", 0.7, now + 1_000);
    expect(decision.shouldCompact).toBeFalse();
    manager.clearBudget("s5");
  });
});
