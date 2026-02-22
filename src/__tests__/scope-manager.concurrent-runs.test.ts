/**
 * Concurrent architect run isolation tests.
 *
 * Two simultaneous runs (different root sessions) must not bleed sessions
 * into each other via isKnownSession. The shared `sessionToRun` Map in
 * ArchitectRunScopeManager is the critical data structure under test.
 */
import { describe, expect, test } from "bun:test";
import { ArchitectRunScopeManager } from "../improvement-audit/scope-manager";

describe("concurrent architect run isolation", () => {
  test("both runs track their own sessions independently", () => {
    const sm = new ArchitectRunScopeManager();
    const runA = sm.startRun("root-A");
    const runB = sm.startRun("root-B");

    sm.attachSession(runA, "proposer-A1");
    sm.attachSession(runB, "proposer-B1");

    expect(sm.isKnownSession("proposer-A1")).toBeTrue();
    expect(sm.isKnownSession("proposer-B1")).toBeTrue();
  });

  test("ending run-A does not affect run-B sessions", () => {
    const sm = new ArchitectRunScopeManager();
    const runA = sm.startRun("root-A");
    const runB = sm.startRun("root-B");

    sm.attachSession(runA, "proposer-A1");
    sm.attachSession(runB, "proposer-B1");

    sm.endRun(runA);

    // run-A's sessions are gone
    expect(sm.isKnownSession("proposer-A1")).toBeFalse();
    // run-B's sessions remain intact
    expect(sm.isKnownSession("proposer-B1")).toBeTrue();
  });

  test("a session ID cannot be attached to two concurrent runs (duplicate-session)", () => {
    const sm = new ArchitectRunScopeManager();
    const runA = sm.startRun("root-A");
    const runB = sm.startRun("root-B");

    const first = sm.attachSession(runA, "shared-worker");
    expect(first).toMatchObject({ ok: true });

    // sessionToRun already maps "shared-worker" → runA
    const second = sm.attachSession(runB, "shared-worker");
    expect(second).toMatchObject({ ok: false, reason: "duplicate-session" });
  });

  test("session freed from run-A can attach to run-B after detach", () => {
    const sm = new ArchitectRunScopeManager();
    const runA = sm.startRun("root-A");
    const runB = sm.startRun("root-B");

    sm.attachSession(runA, "shared-worker");
    sm.detachSession(runA, "shared-worker");

    const reattach = sm.attachSession(runB, "shared-worker");
    expect(reattach).toMatchObject({ ok: true });
    expect(sm.isKnownSession("shared-worker")).toBeTrue();
  });

  test("endRun on run-A does not delete run-B's Map entry", () => {
    const sm = new ArchitectRunScopeManager();
    const runA = sm.startRun("root-A");
    const runB = sm.startRun("root-B");
    sm.attachSession(runB, "critic-B1");

    sm.endRun(runA);

    // run-B's internal scope object must still exist and be retrievable
    expect(sm.getRun(runB)).toBeDefined();
    expect(sm.getRun(runB)?.state).toBe("running");
  });

  test("three concurrent runs do not cross-contaminate", () => {
    const sm = new ArchitectRunScopeManager();
    const runs = ["root-X", "root-Y", "root-Z"].map((r) => sm.startRun(r));

    runs.forEach((runId, i) => sm.attachSession(runId, `worker-${i}`));

    sm.endRun(runs[0]);

    expect(sm.isKnownSession("worker-0")).toBeFalse();
    expect(sm.isKnownSession("worker-1")).toBeTrue();
    expect(sm.isKnownSession("worker-2")).toBeTrue();
  });
});
