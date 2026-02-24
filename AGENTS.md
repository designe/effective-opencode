# AGENTS.md

This document is a practical guide for agents working on this repository.
It is based on the current source code.

## 1. Project Snapshot

- Project: `effective-opencode`
- Version: `0.1.1`
- Language: TypeScript (ESM, strict mode)
- Build output: `dist/`
- Plugin entry: `src/index.ts`
- Runtime target: opencode plugin with multiple hooks and tools

## 2. Core Tool Surfaces

### `effective`
- Runs a two-agent architecture debate loop to consensus.
- Creates proposer/critic sub-sessions, prompts them round-by-round, parses verdicts, returns final design.
- Saves transcript to `.opencode/architect-debates/<timestamp>.md`.
- Sub-session attachment is **run-scoped** — each invocation gets its own isolated `Set<string>` tracked by `ArchitectRunScopeManager`.

### `refactor`
- Generates file scaffolding from a design string.
- Supports `generate`, `preview`, `apply`, `rollback`, `list`, `generate-tests`, `apply-tests` actions.
- Stores rollback checkpoints under `.opencode/refactor-checkpoints/`.

## 3. Module Map

### `src/index.ts`
- Main plugin wiring.
- Reads config from `effectiveOpencode` or `architectPlugin` blocks in `opencode.json`.
- Registers hooks: `config`, `permission.ask`, `event`, `experimental.chat.system.transform`, `tool.execute.before`.
- Registers tools: `effective`, `refactor`.
- Holds singleton `ArchitectRunScopeManager` (`scopeManager`).
- Exposes `isAutoApprovableSession = (id) => scopeManager.isKnownSession(id)` — the **single canonical predicate** used by both `permission.ask` and `permission.updated` hooks.
- Per effective invocation: creates a fresh `runSessions = new Set<string>()` and passes `onSessionCreated` callback to `runDebate` so scope manager drives attachment.

### `src/debate-engine.ts`
- Debate orchestration, retry/fallback model logic.
- `DebateInput.onSessionCreated?(sessionID, agent)` — optional callback called after each sub-session is created; must return `AttachResult`. If it returns `{ ok: false }`, the run **fails fast** with a descriptive error.
- `AttachResult` is re-exported from this module for consumers that don't import from `scope-manager` directly.
- `createdSessions: string[]` ledger tracks all sessions created during a run so cleanup iterates them correctly even if creation was partial.
- `attachSession(agent, createFn)` local helper: creates session → records in ledger → calls callback → throws on failure → adds to `architectSessions` compat set.
- Sub-sessions are created in parallel via `Promise.all`.
- Optional tmux split-pane live TUI view (`createTmuxDebateView`). Skipped if server URL is unreachable (1.2 s probe).
- Cleanup removes all ledger sessions from `architectSessions` in `finally`.

### `src/improvement-audit/scope-manager.ts`
- `ArchitectRunScopeManager` — owns run membership state.
- `startRun(rootSessionID): string` — creates a fresh isolated run; throws if a run is already active for that root session.
- `attachSession(runId, sessionID): AttachResult` — registers a sub-session; returns typed failure on run-not-found / run-ended / duplicate.
- `detachSession(runId, sessionID): void` — removes session from run and reverse index.
- `isKnownSession(sessionID): boolean` — O(1) lookup via `sessionToRun` reverse index.
- `endRun(runId): void` — atomically detaches all member sessions then removes run; safe to call with `undefined` or unknown runId.
- `sessionToRun: Map<string, string>` — prevents any session ID from belonging to two concurrent runs.

### `src/context.ts`
- Gathers context from `ctx.directory` (not the opencode worktree path).
- Collects file tree + config files + entry points in parallel.
- File tree capped at max depth and count to keep context payload bounded.

### `src/prompts.ts`
- Proposer/critic personas as inline constants.
- Prompt builders for each debate phase.
- Result/transcript formatters.

### `src/consensus.ts`
- Parses fenced `json:verdict` blocks.
- Fallback: `APPROVED:` keyword.
- Consensus rule: `approved === true && score >= 7`.

### `src/logger.ts`
- Console + file logger via `createContextLogger(name)`.
- Log file: `~/.local/share/opencode/effective-opencode.log`.
- Runtime level: `OPENCODE_LOG_LEVEL` env var (`debug|info|warn|error`).

### `src/security/index.ts`
- Command/content hash-based authorization cache.
- Cache file: `~/.opencode/security_cache.json`.

### `src/skills/index.ts`
- Loads workspace skills from `.opencode/skills/<name>/`.
- Requires `skill.json` + `instructions.md` per skill.
- Activates skills by recent file-path pattern match (`minimatch`).

### `src/tmux-view.ts`
- Creates tmux split-pane TUI view for live debate monitoring.
- Probes server URL reachability (1.2 s timeout, GET `/`) before attempting to attach.
- Skipped silently if TMUX env is unset or server is unreachable.

### `src/refactor/*`
- `scaffolder.ts`: file extraction + template generation.
- `differ.ts`: preview diff generation and markdown formatting.
- `rollback.ts`: checkpoint create/restore/list/delete.
- `test-generator.ts`: test template generation (vitest/jest/bun).
- `index.ts`: orchestration via `RefactorEngine`.

### `src/improvement-audit/*`
- `pipeline.ts`: orchestrates the improvement-audit execution mode.
- `policy.ts`: rule-based audit policy evaluation.
- `analyze/`: context, security, and perf analysis rules.
- `args.ts`, `types.ts`, `format.ts`, `prompt.ts`, `snapshot.ts`, `synthetic-outcome.ts`.

## 4. High-Risk Flows — Invariants to Preserve

### 1. Architect sub-session permissions must never block
Multiple safety layers work in sequence:
- `config` hook injects agent-mode settings.
- `createArchitectSession` embeds pre-granted permissions in the session create body.
- `permission.ask` hook: `isAutoApprovableSession(sessionID)` → auto-allow.
- `event` hook: `permission.updated` fallback — calls API to approve if `isAutoApprovableSession` matches.

### 2. Run-scoped session ownership
- `scopeManager.startRun(rootSessionID)` always creates a **fresh** internal `Set` — no external set is shared across runs.
- `onSessionCreated` callback is the **authoritative** registration point. If it returns `{ ok: false }`, `runDebate` throws immediately so no partially-attached sessions linger.
- `endRun` is always called in `finally` in `src/index.ts`.
- `createdSessions` ledger in `debate-engine.ts` ensures cleanup is correct even when only the proposer was created before a crash.

### 3. No cross-run session bleed
- `sessionToRun` reverse index in `ArchitectRunScopeManager` guarantees a session ID cannot appear in two concurrent runs.
- `endRun` on run-A has no effect on run-B's entries.

### 4. Timeout / abort handling in `promptSession`
- On timeout or `AbortSignal` fire, `session.abort()` is invoked.
- Abort listeners and timers are always cleaned up in `finally`.

### 5. Context collection stays bounded
- File tree depth and count limits are enforced in `src/context.ts`.

## 5. Local Development

```bash
# Install dependencies
bun install          # or: npm install

# Build
npm run build        # tsc → dist/

# Tests (targeted — avoids dist/ duplication)
bun test ./src/__tests__/**/*.test.ts

# Full suite shorthand (same as above via package.json script)
npm test
```

> **Note:** Running bare `bun test` without a path glob will also pick up `dist/__tests__/` after a build, causing duplicate test runs. Always target `src/__tests__/` explicitly, or use `npm test` which sets the glob correctly.

## 6. Test Coverage Map

| File | What it covers |
|------|---------------|
| `improvement-audit.scope-manager.test.ts` | Core `ArchitectRunScopeManager` API: startRun, attachSession, detachSession, endRun, duplicate rejection |
| `scope-manager.permission-boundary.test.ts` | `isKnownSession` as permission hook predicate: allows during active run, denies after `endRun`, root session never auto-approvable |
| `scope-manager.concurrent-runs.test.ts` | Concurrent run isolation: no cross-run bleed, independent session tracking, 3-run contamination test |
| `debate-engine.visibility.test.ts` | Visibility callback contract, `onSessionCreated` registration/failure paths, compatibility set cleanup |
| `consensus.test.ts` | Verdict parsing, keyword fallback, consensus threshold |
| `types.test.ts` | `parseModelString`, `formatModelString`, `DEFAULT_CONFIG` (timeoutMs = 300 000) |
| `prompts.test.ts` | Prompt builders and formatters |
| `logger.test.ts` | Log level filtering, error serialization |
| `improvement-audit.*.test.ts` | Args parsing, policy evaluation, synthetic outcome generation |
| `security.command-parser.test.ts` | Command hash authorization |
| `refactor.test-generator.test.ts` | Test template generation |
| `context.mutation-policy.test.ts` | Context mutation policy rules |
| `model-utils.test.ts` | Model selection utilities |

## 7. Configuration Reference

All options go under `effectiveOpencode` (preferred) or `architectPlugin` in `opencode.json`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxRounds` | `number` | `3` | Max debate rounds |
| `retainSessions` | `boolean` | `false` | Keep sub-sessions after debate |
| `timeoutMs` | `number` | `300000` | Per-prompt timeout (ms) |
| `proposerModel` | `string` | auto-detect | Model for Architect-1 |
| `criticModel` | `string` | auto-detect | Model for Architect-2 |
| `proposerPersona` | `string` | built-in | Custom system prompt for Architect-1 |
| `criticPersona` | `string` | built-in | Custom system prompt for Architect-2 |
| `improvementAudit` | object | — | Improvement-audit policy block |

## 8. Recommended Agent Workflow

1. Read `src/index.ts` + the target module before making edits.
2. If touching the architect flow, verify:
   - `scopeManager.attachSession` / `onSessionCreated` contract
   - `createdSessions` ledger cleanup in `debate-engine.ts`
   - `isAutoApprovableSession` is the only place `isKnownSession` is called for permissions
3. If touching the refactor flow, verify:
   - Preview output correctness
   - Checkpoint creation and restoration
   - No unintended file overwrites
4. Run:
   ```bash
   npm run build
   npm test
   ```
5. Call out in reports whether failures come from new changes or pre-existing issues.
