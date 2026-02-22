export interface ArchitectRunScope {
  runId: string;
  rootSessionID: string;
  startedAt: number;
  state: "running" | "ended";
  sessions: Set<string>;
}

export type AttachResult =
  | { ok: true }
  | { ok: false; reason: "run-not-found" | "run-ended" | "duplicate-session" };

export class ArchitectRunScopeManager {
  private readonly runs = new Map<string, ArchitectRunScope>();
  private readonly sessionToRun = new Map<string, string>();

  startRun(rootSessionID: string): string {
    const existing = this.runs.get(rootSessionID);
    if (existing && existing.state === "running") {
      throw new Error(`architect run already active for root session ${rootSessionID}`);
    }

    this.runs.delete(rootSessionID);
    const run: ArchitectRunScope = {
      runId: rootSessionID,
      rootSessionID,
      startedAt: Date.now(),
      state: "running",
      sessions: new Set<string>(),
    };
    this.runs.set(rootSessionID, run);
    return rootSessionID;
  }

  attachSession(runId: string, sessionID: string): AttachResult {
    const run = this.runs.get(runId);
    if (!run) {
      return { ok: false, reason: "run-not-found" };
    }
    if (run.state !== "running") {
      return { ok: false, reason: "run-ended" };
    }
    if (this.sessionToRun.has(sessionID)) {
      return { ok: false, reason: "duplicate-session" };
    }

    run.sessions.add(sessionID);
    this.sessionToRun.set(sessionID, runId);
    return { ok: true };
  }

  detachSession(runId: string, sessionID: string): void {
    const run = this.runs.get(runId);
    if (!run) return;

    run.sessions.delete(sessionID);
    const ownerRunId = this.sessionToRun.get(sessionID);
    if (ownerRunId === runId) {
      this.sessionToRun.delete(sessionID);
    }
  }

  isKnownSession(sessionID: string): boolean {
    return this.sessionToRun.has(sessionID);
  }

  isAuditSession(sessionID: string, executionMode?: string): boolean {
    if (executionMode && executionMode !== "improvement-audit") return false;
    return this.isKnownSession(sessionID);
  }

  isReentrantAuditInvocation(sessionID: string, executionMode: string): boolean {
    return this.isAuditSession(sessionID, executionMode);
  }

  endRun(runId: string | undefined): void {
    if (!runId) return;
    const run = this.runs.get(runId);
    if (!run) return;

    for (const sessionID of [...run.sessions]) {
      this.detachSession(runId, sessionID);
    }
    run.state = "ended";
    this.runs.delete(runId);
  }

  getRun(runID: string): ArchitectRunScope | undefined {
    return this.runs.get(runID);
  }

  getRunBySession(sessionID: string): ArchitectRunScope | undefined {
    for (const run of this.runs.values()) {
      if (run.rootSessionID === sessionID) return run;
      if (run.sessions.has(sessionID)) return run;
    }

    return undefined;
  }

  listSessions(runId: string): string[] {
    const run = this.runs.get(runId);
    return run ? Array.from(run.sessions) : [];
  }
}
