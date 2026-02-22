/**
 * Permission hook boundary tests for ArchitectRunScopeManager.
 *
 * These tests assert on `isKnownSession` specifically — the exact predicate
 * used in the `permission.ask` hook in index.ts:
 *   const isArchitect = isAutoApprovableSession(input.sessionID);
 *   // where: isAutoApprovableSession = (id) => scopeManager.isKnownSession(id)
 */
import { describe, expect, test } from "bun:test";
import { ArchitectRunScopeManager } from "../improvement-audit/scope-manager";

describe("permission hook boundary — isKnownSession", () => {
  test("allows during active run (permission.ask should grant)", () => {
    const sm = new ArchitectRunScopeManager();
    const runId = sm.startRun("root-1");
    sm.attachSession(runId, "proposer-a");

    expect(sm.isKnownSession("proposer-a")).toBeTrue();
  });

  test("denies after endRun (permission.ask must not grant)", () => {
    const sm = new ArchitectRunScopeManager();
    const runId = sm.startRun("root-1");
    sm.attachSession(runId, "proposer-a");

    sm.endRun(runId);

    // endRun calls detachSession for each member → removes from sessionToRun map
    // isKnownSession checks sessionToRun.has(), so this must be false
    expect(sm.isKnownSession("proposer-a")).toBeFalse();
  });

  test("endRun clears all attached sessions atomically", () => {
    const sm = new ArchitectRunScopeManager();
    const runId = sm.startRun("root-1");
    sm.attachSession(runId, "proposer-a");
    sm.attachSession(runId, "critic-b");

    sm.endRun(runId);

    expect(sm.isKnownSession("proposer-a")).toBeFalse();
    expect(sm.isKnownSession("critic-b")).toBeFalse();
  });

  test("endRun(undefined) is a no-op — does not throw", () => {
    const sm = new ArchitectRunScopeManager();
    expect(() => sm.endRun(undefined)).not.toThrow();
  });

  test("endRun on unknown runId is a no-op — does not throw", () => {
    const sm = new ArchitectRunScopeManager();
    // Calling endRun for a runId that was never started must not throw
    expect(() => sm.endRun("nonexistent-run")).not.toThrow();
  });

  test("unattached session is always denied", () => {
    const sm = new ArchitectRunScopeManager();
    sm.startRun("root-1");

    // A session that was never attached must not be auto-approved
    expect(sm.isKnownSession("random-interloper")).toBeFalse();
  });

  test("root session itself is never auto-approvable", () => {
    const sm = new ArchitectRunScopeManager();
    const runId = sm.startRun("root-1");

    // The root/lead session is not registered in sessionToRun — only sub-sessions are
    expect(sm.isKnownSession(runId)).toBeFalse();
  });
});
