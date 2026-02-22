export interface ArchitectRunScope {
  runId: string;
  rootSessionID: string;
  startedAt: number;
  state: "running" | "ended";
  sessions: Set<string>;
}

export class ArchitectRunScopeManager {
  private readonly runs = new Map<string, ArchitectRunScope>();

  startRun(rootSessionID: string, sessionSet?: Set<string>): string {
    const existing = this.runs.get(rootSessionID);
    if (existing && existing.state === "running") {
      throw new Error(`architect run already active for root session ${rootSessionID}`);
    }

    const sessions = sessionSet ?? new Set<string>();
    sessions.clear();

    this.runs.delete(rootSessionID);
    const run: ArchitectRunScope = {
      runId: rootSessionID,
      rootSessionID,
      startedAt: Date.now(),
      state: "running",
      sessions,
    };
    this.runs.set(rootSessionID, run);
    return rootSessionID;
  }

  isKnownSession(sessionID: string): boolean {
    for (const run of this.runs.values()) {
      if (run.state === "running" && run.sessions.has(sessionID)) return true;
    }
    return false;
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
