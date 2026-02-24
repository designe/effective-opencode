import type { CompactDecision, TimeBudgetConfig, TimeBudgetState } from "./types";

type TimerHandle = ReturnType<typeof setTimeout>;

export interface BudgetSnapshot {
  sessionID: string;
  startedAt: number;
  deadlineAt: number;
  durationMs: number;
  elapsedMs: number;
  remainingMs: number;
  elapsedRatio: number;
  status: TimeBudgetState["status"];
}

export class TimeBudgetManager {
  private readonly budgets = new Map<string, TimeBudgetState>();

  private readonly timers = new Map<string, TimerHandle>();

  private readonly config: TimeBudgetConfig;

  private readonly onExpired: (sessionID: string) => void | Promise<void>;

  constructor(params: {
    config: TimeBudgetConfig;
    onExpired: (sessionID: string) => void | Promise<void>;
  }) {
    this.config = params.config;
    this.onExpired = params.onExpired;
  }

  startBudget(sessionID: string, durationMs: number, now = Date.now()): TimeBudgetState {
    if (!Number.isFinite(durationMs) || durationMs < 60_000) {
      throw new Error("Time budget must be at least 1 minute");
    }

    this.clearBudget(sessionID);

    const state: TimeBudgetState = {
      sessionID,
      startedAt: now,
      deadlineAt: now + Math.floor(durationMs),
      durationMs: Math.floor(durationMs),
      status: "active",
      compact: {
        maxObservedUsageRatio: 0,
        progressTriggered: new Set<number>(),
      },
    };

    this.budgets.set(sessionID, state);
    this.scheduleTimer(sessionID);
    return state;
  }

  clearBudget(sessionID: string): void {
    const timer = this.timers.get(sessionID);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionID);
    }
    this.budgets.delete(sessionID);
  }

  hasBudget(sessionID: string): boolean {
    return this.budgets.has(sessionID);
  }

  getState(sessionID: string): TimeBudgetState | undefined {
    return this.budgets.get(sessionID);
  }

  getSnapshot(sessionID: string, now = Date.now()): BudgetSnapshot | undefined {
    const state = this.budgets.get(sessionID);
    if (!state) return undefined;

    const elapsedMs = Math.max(0, now - state.startedAt);
    const remainingMs = Math.max(0, state.deadlineAt - now);
    const elapsedRatio = state.durationMs > 0 ? Math.min(1, elapsedMs / state.durationMs) : 1;

    return {
      sessionID,
      startedAt: state.startedAt,
      deadlineAt: state.deadlineAt,
      durationMs: state.durationMs,
      elapsedMs,
      remainingMs,
      elapsedRatio,
      status: state.status,
    };
  }

  shouldBlockTools(sessionID: string, now = Date.now()): boolean {
    const snapshot = this.getSnapshot(sessionID, now);
    if (!snapshot) return false;
    return snapshot.remainingMs <= 0 || snapshot.elapsedRatio >= this.config.finalizingThreshold;
  }

  isExpired(sessionID: string, now = Date.now()): boolean {
    const snapshot = this.getSnapshot(sessionID, now);
    return !!snapshot && snapshot.remainingMs <= 0;
  }

  getDeadline(sessionID: string): number | undefined {
    return this.budgets.get(sessionID)?.deadlineAt;
  }

  evaluateCompact(
    sessionID: string,
    usageRatio: number,
    now = Date.now(),
  ): CompactDecision {
    const state = this.budgets.get(sessionID);
    if (!state || !Number.isFinite(usageRatio)) {
      return { shouldCompact: false };
    }

    const snapshot = this.getSnapshot(sessionID, now);
    if (!snapshot) return { shouldCompact: false };

    state.compact.maxObservedUsageRatio = Math.max(state.compact.maxObservedUsageRatio, usageRatio);

    const lastRunAt = state.compact.lastRunAt;
    const inCooldown =
      typeof lastRunAt === "number" && now - lastRunAt < this.config.compactCooldownMs;

    if (usageRatio >= this.config.compactHardThreshold) {
      return {
        shouldCompact: true,
        reason: "hard-threshold",
        usageRatio,
        elapsedRatio: snapshot.elapsedRatio,
      };
    }

    if (inCooldown) {
      return { shouldCompact: false, usageRatio, elapsedRatio: snapshot.elapsedRatio };
    }

    if (usageRatio >= this.config.compactSoftThreshold) {
      return {
        shouldCompact: true,
        reason: "soft-threshold",
        usageRatio,
        elapsedRatio: snapshot.elapsedRatio,
      };
    }

    for (const checkpoint of this.config.compactProgressCheckpoints) {
      if (snapshot.elapsedRatio >= checkpoint && !state.compact.progressTriggered.has(checkpoint)) {
        return {
          shouldCompact: true,
          reason: "progress-checkpoint",
          usageRatio,
          elapsedRatio: snapshot.elapsedRatio,
        };
      }
    }

    return { shouldCompact: false, usageRatio, elapsedRatio: snapshot.elapsedRatio };
  }

  markCompacted(sessionID: string, now = Date.now()): void {
    const state = this.budgets.get(sessionID);
    if (!state) return;

    const snapshot = this.getSnapshot(sessionID, now);
    if (!snapshot) return;

    state.compact.lastRunAt = now;
    for (const checkpoint of this.config.compactProgressCheckpoints) {
      if (snapshot.elapsedRatio >= checkpoint) {
        state.compact.progressTriggered.add(checkpoint);
      }
    }
  }

  private scheduleTimer(sessionID: string, now = Date.now()): void {
    const state = this.budgets.get(sessionID);
    if (!state) return;

    const remainingMs = state.deadlineAt - now;
    if (remainingMs <= 0) {
      this.handleExpiration(sessionID);
      return;
    }

    const timerMs = Math.min(this.config.timerChunkMs, remainingMs);
    const timer = setTimeout(() => {
      this.scheduleTimer(sessionID);
    }, timerMs);

    const prev = this.timers.get(sessionID);
    if (prev) clearTimeout(prev);
    this.timers.set(sessionID, timer);

    if (state.status !== "finalizing") {
      const elapsedRatio = (Date.now() - state.startedAt) / state.durationMs;
      if (elapsedRatio >= this.config.finalizingThreshold) {
        state.status = "finalizing";
      }
    }
  }

  private handleExpiration(sessionID: string): void {
    const state = this.budgets.get(sessionID);
    if (!state) return;
    state.status = "expired";

    const timer = this.timers.get(sessionID);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionID);
    }

    Promise.resolve(this.onExpired(sessionID)).catch(() => {
      // non-fatal: expiration handler failures should not crash plugin runtime
    });
  }
}
