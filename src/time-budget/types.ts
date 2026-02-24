export type BudgetStatus = "active" | "finalizing" | "expired";

export interface TimeBudgetState {
  sessionID: string;
  startedAt: number;
  deadlineAt: number;
  durationMs: number;
  status: BudgetStatus;
  compact: {
    lastRunAt?: number;
    maxObservedUsageRatio: number;
    progressTriggered: Set<number>;
  };
}

export interface TimeBudgetConfig {
  enabled: boolean;
  finalizingThreshold: number;
  compactSoftThreshold: number;
  compactHardThreshold: number;
  compactCooldownMs: number;
  compactProgressCheckpoints: number[];
  timerChunkMs: number;
}

export interface CompactDecision {
  shouldCompact: boolean;
  reason?: "hard-threshold" | "soft-threshold" | "progress-checkpoint";
  usageRatio?: number;
  elapsedRatio?: number;
}
