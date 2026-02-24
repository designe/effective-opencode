# effective-opencode

An [opencode](https://github.com/anomalyco/opencode) plugin that enables two AI software architects to pair program on your design problems — debating, critiquing, and iterating to consensus before implementation begins.

## Overview

When you describe a feature or system to build, the plugin spins up two architect agents in separate sub-sessions:

- **Architect-1 (Proposer)** — proposes an initial design based on your vision and the current codebase
- **Architect-2 (Critic)** — critically reviews the proposal and returns a structured verdict

They iterate back and forth until consensus is reached (Critic scores ≥ 7 and approves), or the maximum round limit is hit. The agreed design is returned to your main session, and a full debate transcript is saved to disk.

```
Lead (you) ──► vision / requirement
                      │
              ┌───────▼────────┐
              │  effective tool │
              └───────┬────────┘
                      │
         ┌────────────▼────────────┐
         │   Architect-1 (Proposer) │  ◄─── project context
         │   proposes design        │
         └────────────┬────────────┘
                      │ proposal
         ┌────────────▼────────────┐
         │   Architect-2 (Critic)   │
         │   critiques + verdict    │
         └────────────┬────────────┘
                      │
              consensus? ──► NO ──► Architect-1 revises ──┐
                      │                                    │
                     YES          ◄────────────────────────┘
                      │
         ┌────────────▼────────────┐
         │   Final design returned  │
         │   to main session        │
         │   Transcript saved       │
         └─────────────────────────┘
```

## Installation

### 1. Install dependencies

```bash
bun install
```

### 2. Register the plugin in `opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file://./src/index.ts"
  ],
  "effectiveOpencode": {
    "maxRounds": 3,
    "debateMode": "sequential",
    "retainSessions": false,
    "timeoutMs": 300000
  }
}
```

> The legacy `architectPlugin` key is also accepted for backwards compatibility.

### 3. Start opencode

```bash
opencode
```

The `effective` and `refactor` tools are now available in your session.

## Tools

### `effective`

Runs a two-agent debate to produce an architectural design. Simply describe what you want to build — the LLM will call the tool when a design session would be valuable.

**Parameters:**
- `vision` — your requirement or task description (required)
- `max_rounds` — override the maximum debate rounds for this run (optional)
- `execution_mode` — `"debate"` (default) or `"improvement-audit"`

**Example prompts:**

```
Design a plugin system for a CLI tool that supports hot-reload and typed configuration.
```

```
I need to add real-time collaboration to our editor. How should we architect the sync layer?
```

### `refactor`

Generates file scaffolding from a design string and supports preview/apply/rollback.

**Actions:** `generate`, `preview`, `apply`, `rollback`, `list`, `generate-tests`, `apply-tests`

**Parameters:**
- `design` — description of the desired file structure or code changes (required)
- `action` — one of the actions above (required)
- `base_dir` — root directory for scaffolding (optional)
- `checkpoint_id` — for rollback/apply (optional)

## How It Works

### Debate Protocol

Each round follows this sequence:

1. **Propose** — Architect-1 produces a structured design: Overview, Components, Interfaces, Data Flow, File Structure
2. **Critique** — Architect-2 reviews it and returns a verdict block:
   ```json
   { "approved": true, "score": 8, "key_issues": ["minor: consider caching layer"] }
   ```
3. **Consensus check** — `approved: true` AND `score >= 7` → stop, return design
4. **Revise** — if no consensus and rounds remain, Architect-1 revises addressing the key issues
5. Repeat from step 2

In `sequential` mode, live TMUX visibility is staged:

1. Proposer pane connects during setup.
2. Critic pane is attached when critique starts.
3. If critic pane attachment fails, debate continues with status-stream visibility.

### Consensus Detection

Verdicts are parsed from fenced `json:verdict` blocks in the Critic's response:

````
```json:verdict
{ "approved": true, "score": 8, "key_issues": [] }
```
````

A keyword fallback (`APPROVED: ...`) handles cases where the model doesn't produce valid JSON.

### Session Lifecycle & Permission Safety

Each effective invocation creates a **run-scoped** pair of sub-sessions:

1. `ArchitectRunScopeManager.startRun(rootSessionID)` opens a fresh isolated scope.
2. `runDebate` creates proposer and critic sessions in parallel, registering each via an `onSessionCreated` callback that calls `scopeManager.attachSession(runId, sessionID)`.
3. Debate execution can run in `sequential` (default) or `parallel` mode. In sequential mode, only the proposer tmux pane is created first; critic pane attachment is deferred until critique starts.
4. If attachment fails (e.g. duplicate session ID), `runDebate` throws immediately — no partially-attached sessions are left in the permission set.
5. The `permission.ask` and `permission.updated` hooks use a single canonical predicate `isAutoApprovableSession(id)` (backed by `scopeManager.isKnownSession`) to auto-approve tool calls from architect sub-sessions.
6. `endRun` in `finally` atomically removes all run sessions from the scope manager, revoking auto-approval.

This design prevents cross-run session bleed when multiple effective runs execute concurrently.

### Project Context

Before the debate begins, the plugin collects context from your codebase:
- File tree (TypeScript/JavaScript files, up to 100 entries)
- Config files: `package.json`, `tsconfig.json`, `opencode.json`, `README.md`
- Entry point source files (up to 3 files, first 200 lines each)

This grounds the architects in your actual project rather than designing in the abstract.

### Output

**Main session** receives a condensed summary:
```
## Architecture Design Consensus (2 rounds)

**Status**: Consensus reached — Approved (score: 8/10)

### Final Design
[full design from Architect-1]

_Full debate transcript: .opencode/architect-debates/1708123456789.md_
```

**Transcript file** (`.opencode/architect-debates/{timestamp}.md`) contains the complete round-by-round exchange including all proposals, critiques, and verdicts.

## Configuration

All options go under `effectiveOpencode` (preferred) or `architectPlugin` in `opencode.json`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxRounds` | `number` | `3` | Maximum debate rounds before stopping |
| `debateMode` | `"sequential" \| "parallel"` | `"sequential"` | Debate orchestration mode and tmux pane timing |
| `retainSessions` | `boolean` | `false` | Keep sub-sessions after debate ends |
| `timeoutMs` | `number` | `300000` | Per-prompt timeout in milliseconds |
| `proposerModel` | `string` | auto-detect | Model for Architect-1 |
| `criticModel` | `string` | auto-detect | Model for Architect-2 |
| `proposerPersona` | `string` | built-in | Custom system prompt for Architect-1 |
| `criticPersona` | `string` | built-in | Custom system prompt for Architect-2 |
| `improvementAudit` | object | — | Improvement-audit policy block |

**Example — custom personas:**

```json
{
  "effectiveOpencode": {
    "maxRounds": 5,
    "debateMode": "parallel",
    "timeoutMs": 300000,
    "proposerPersona": "You are a pragmatic backend engineer who values simplicity...",
    "criticPersona": "You are a strict API designer who enforces REST conventions..."
  }
}
```

## File Structure

```
effective-opencode/
├── opencode.json              # Plugin registration and configuration
├── package.json               # Dependencies
├── tsconfig.json              # TypeScript configuration
├── AGENTS.md                  # Guide for AI agents working on this repo
└── src/
    ├── index.ts               # Plugin entry — hooks, tools, scope manager singleton
    ├── debate-engine.ts       # Debate loop, session lifecycle, onSessionCreated contract
    ├── prompts.ts             # Architect personas and prompt builders
    ├── consensus.ts           # Verdict parsing and consensus detection
    ├── context.ts             # Project context gathering
    ├── types.ts               # Shared TypeScript interfaces and DEFAULT_CONFIG
    ├── logger.ts              # Structured logger
    ├── model-utils.ts         # Model selection utilities
    ├── tmux-view.ts           # Optional live TUI via tmux split-pane
    ├── improvement-audit/
    │   ├── scope-manager.ts   # ArchitectRunScopeManager — run-scoped session tracking
    │   ├── pipeline.ts        # Improvement-audit execution mode orchestration
    │   ├── policy.ts          # Rule-based audit policy evaluation
    │   └── analyze/           # Context, security, and perf analysis rules
    ├── refactor/
    │   ├── index.ts           # RefactorEngine orchestration
    │   ├── scaffolder.ts      # File extraction and template generation
    │   ├── differ.ts          # Diff preview and markdown formatting
    │   ├── rollback.ts        # Checkpoint create/restore/list/delete
    │   └── test-generator.ts  # Test template generation (vitest/jest/bun)
    ├── security/
    │   └── index.ts           # Command/content hash-based authorization cache
    ├── skills/
    │   └── index.ts           # Workspace skill loader (minimatch-based activation)
    └── __tests__/             # All test files (bun:test)
```

## Local Development

```bash
# Install dependencies
bun install

# Build
npm run build        # tsc → dist/

# Run tests (targeted — avoids dist/ duplication)
npm test             # bun test ./src/__tests__/**/*.test.ts
```

> Running bare `bun test` without a path glob picks up `dist/__tests__/` after a build, causing duplicate runs. Use `npm test` or target `src/__tests__/` explicitly.

## Requirements

- [opencode](https://github.com/anomalyco/opencode) installed
- [Bun](https://bun.sh) runtime
- An AI model configured in opencode
