# AGENT.md

This document is a practical guide for agents working on this repository.
It is based on the current source code (not just README).

## 1. Project Snapshot

- Project: `effective-opencode`
- Language: TypeScript (ESM, strict mode)
- Build output: `dist/`
- Plugin entry: `src/index.ts`
- Runtime target: opencode plugin with multiple hooks and tools

## 2. Core Responsibilities

The plugin currently has two main tool surfaces:

1. `architect`
- Runs a two-agent architecture debate loop to consensus.
- Creates proposer/critic sub-sessions, prompts them round-by-round, parses verdicts, and returns final design.
- Saves transcript to `.opencode/architect-debates/<timestamp>.md`.

2. `refactor`
- Generates scaffolding from design text.
- Supports preview/apply/rollback/list checkpoints/test scaffolding generation.
- Stores rollback checkpoints under `.opencode/refactor-checkpoints/`.

## 3. Module Map (Current Code)

- `src/index.ts`
  - Main plugin wiring.
  - Handles config overrides from `effectiveOpencode` or `architectPlugin`.
  - Registers hooks: `config`, `permission.ask`, `event`, `experimental.chat.system.transform`, `tool.execute.before`.
  - Registers tools: `architect`, `refactor`.

- `src/debate-engine.ts`
  - Debate orchestration and retries/fallback model logic.
  - Sub-session creation with pre-granted permissions.
  - Optional tmux split-pane live TUI view.
  - Session cleanup and transcript persistence.

- `src/context.ts`
  - Gathers context from `ctx.directory` (not opencode worktree path).
  - Collects file tree + config files + entry points in parallel.

- `src/prompts.ts`
  - Proposer/critic personas.
  - Prompt builders and result/transcript formatters.

- `src/consensus.ts`
  - Parses fenced `json:verdict` blocks.
  - Fallback: `APPROVED:` keyword.
  - Consensus rule: `approved === true && score >= 7`.

- `src/logger.ts`
  - Console + file logger.
  - Log file: `~/.local/share/opencode/effective-opencode.log`.
  - Runtime level: `OPENCODE_LOG_LEVEL` (`debug|info|warn|error`).

- `src/security/index.ts`
  - Command/content hash-based authorization cache.
  - Cache file: `~/.opencode/security_cache.json`.

- `src/skills/index.ts`
  - Loads workspace skills from `.opencode/skills/<name>/`.
  - Requires `skill.json` + `instructions.md`.
  - Activates skills by recent file-path pattern match (`minimatch`).

- `src/refactor/*`
  - `scaffolder.ts`: file extraction + template generation.
  - `differ.ts`: preview diff generation and markdown formatting.
  - `rollback.ts`: checkpoint create/restore/list/delete.
  - `test-generator.ts`: test template generation (vitest/jest/bun).
  - `index.ts`: orchestration via `RefactorEngine`.

## 4. High-Risk Flows to Preserve

When editing behavior, preserve these invariants:

1. Architect sub-session permissions must not block.
- There are multiple safety layers:
  - Agent injection in `config`.
  - Session create body includes pre-granted permissions.
  - `permission.ask` auto-allow based on tracked architect session IDs.
  - `event` hook fallback auto-approval via API on `permission.updated`.

2. `architectSessions` lifecycle must stay correct.
- Add both sub-session IDs after creation.
- Always remove them in `finally`, before cleanup completes.

3. Timeout/cancel handling in `promptSession`.
- On timeout or user abort, `session.abort()` is invoked.
- Abort listeners and timers must be cleaned in `finally`.

4. Context collection should remain bounded.
- File tree max depth and count limits prevent large context payloads.

## 5. Local Development Commands

- Install deps:
  - `bun install` (or `npm install`, lockfiles for both exist)
- Build:
  - `npm run build`
- Tests:
  - `bun test`

## 6. Current Known Mismatches / Paper Cuts

1. `README.md` is partially outdated.
- README describes mainly architect flow and older defaults.
- Source includes additional subsystems (`security`, `skills`, `refactor`) and updated behavior.

2. Default timeout mismatch in tests.
- `src/types.ts` sets `DEFAULT_CONFIG.timeoutMs = 300_000`.
- `src/__tests__/types.test.ts` expects `120_000`.
- `bun test` currently fails on this mismatch.

3. Duplicate test execution from `dist/__tests__`.
- `bun test` runs both `src/__tests__` and compiled `dist/__tests__`.
- This duplicates failures and slows feedback.

## 7. Recommended Agent Workflow

1. Read `src/index.ts` + target module before edits.
2. If touching architect flow, verify:
- consensus parsing
- session cleanup
- permission auto-approval path
3. If touching refactor flow, verify:
- preview output
- checkpoint creation/restoration
- no unintended overwrite behavior
4. Run:
- `npm run build`
- `bun test` (or targeted tests)
5. In reports, call out whether failures are from new changes or known baseline issues.

## 8. Suggested Next Maintenance Tasks

1. Align timeout default between `types.ts`, tests, and README.
2. Prevent duplicate test runs (`dist/__tests__`) in Bun config/test script.
3. Add tests for `refactor`, `security`, and `skills` modules (currently sparse/non-existent).
