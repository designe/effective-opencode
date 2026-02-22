import { describe, expect, test } from "bun:test";

import { ArchitectRunScopeManager } from "../improvement-audit/scope-manager";

describe("ArchitectRunScopeManager", () => {
  test("tracks root run sessions and supports cleanup", () => {
    const manager = new ArchitectRunScopeManager();
    const sharedSessions = new Set<string>();

    const runId = manager.startRun("root-session", sharedSessions);
    expect(runId).toBe("root-session");
    expect(manager.isKnownSession("root-session")).toBeFalse();

    sharedSessions.add("proposer-1");
    sharedSessions.add("critic-2");

    expect(manager.isKnownSession("proposer-1")).toBeTrue();
    expect(manager.isKnownSession("critic-2")).toBeTrue();
    expect(manager.getRun(runId)?.sessions.has("proposer-1")).toBeTrue();

    manager.endRun(runId);
    expect(manager.getRun(runId)).toBeUndefined();
  });

  test("blocks overlapping runs from same root session", () => {
    const manager = new ArchitectRunScopeManager();
    const sharedSessions = new Set<string>();

    manager.startRun("root", sharedSessions);
    expect(() => manager.startRun("root", sharedSessions)).toThrow(
      /already active for root session root/,
    );

    manager.endRun("root");
    expect(() => manager.startRun("root", sharedSessions)).not.toThrow();
  });

  test("supports lookup by member session", () => {
    const manager = new ArchitectRunScopeManager();
    const sharedSessions = new Set<string>();

    manager.startRun("root", sharedSessions);
    sharedSessions.add("sub-1");
    sharedSessions.add("sub-2");

    const run = manager.getRunBySession("sub-1");
    expect(run?.rootSessionID).toBe("root");
  });
});
