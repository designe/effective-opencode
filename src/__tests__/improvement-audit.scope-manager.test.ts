import { describe, expect, test } from "bun:test";

import { ArchitectRunScopeManager } from "../improvement-audit/scope-manager";

describe("ArchitectRunScopeManager", () => {
  test("tracks root run sessions and supports cleanup", () => {
    const manager = new ArchitectRunScopeManager();

    const runId = manager.startRun("root-session");
    expect(runId).toBe("root-session");
    expect(manager.isKnownSession("root-session")).toBeFalse();

    expect(manager.attachSession(runId, "proposer-1").ok).toBeTrue();
    expect(manager.attachSession(runId, "critic-2").ok).toBeTrue();

    expect(manager.isKnownSession("proposer-1")).toBeTrue();
    expect(manager.isKnownSession("critic-2")).toBeTrue();
    expect(manager.getRun(runId)?.sessions.has("proposer-1")).toBeTrue();

    manager.detachSession(runId, "proposer-1");
    expect(manager.isKnownSession("proposer-1")).toBeFalse();

    manager.endRun(runId);
    expect(manager.getRun(runId)).toBeUndefined();
  });

  test("blocks overlapping runs from same root session", () => {
    const manager = new ArchitectRunScopeManager();

    manager.startRun("root");
    expect(() => manager.startRun("root")).toThrow(
      /already active for root session root/,
    );

    manager.endRun("root");
    expect(() => manager.startRun("root")).not.toThrow();
  });

  test("supports lookup by member session", () => {
    const manager = new ArchitectRunScopeManager();

    const runId = manager.startRun("root");
    manager.attachSession(runId, "sub-1");
    manager.attachSession(runId, "sub-2");

    const run = manager.getRunBySession("sub-1");
    expect(run?.rootSessionID).toBe("root");
  });

  test("rejects duplicate session attachment", () => {
    const manager = new ArchitectRunScopeManager();
    const firstRunId = manager.startRun("root-1");
    const secondRunId = manager.startRun("root-2");

    const firstAttach = manager.attachSession(firstRunId, "shared-session");
    expect(firstAttach).toMatchObject({ ok: true });

    const duplicateAttach = manager.attachSession(secondRunId, "shared-session");
    expect(duplicateAttach).toMatchObject({ ok: false, reason: "duplicate-session" });

    manager.detachSession(firstRunId, "shared-session");
    const attachAfterDetach = manager.attachSession(secondRunId, "shared-session");
    expect(attachAfterDetach).toMatchObject({ ok: true });
  });
});
