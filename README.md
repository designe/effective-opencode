# opencode-architect-plugin

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
              │  architect tool │
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
  "architectPlugin": {
    "maxRounds": 3,
    "retainSessions": false,
    "timeoutMs": 120000
  }
}
```

### 3. Start opencode

```bash
opencode
```

The `architect` tool is now available in your session.

## Usage

Simply describe what you want to build. The LLM will automatically call the `architect` tool when it determines an architectural design session would be valuable.

**Example prompts:**

```
Design a plugin system for a CLI tool that supports hot-reload and typed configuration.
```

```
I need to add real-time collaboration to our editor. How should we architect the sync layer?
```

```
Plan the architecture for a multi-tenant API with per-tenant rate limiting and audit logs.
```

The tool accepts:
- `vision` — your requirement or task description (required)
- `max_rounds` — override the maximum debate rounds for this session (optional)

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

### Consensus Detection

Verdicts are parsed from fenced `json:verdict` blocks in the Critic's response:

````
```json:verdict
{ "approved": true, "score": 8, "key_issues": [] }
```
````

A keyword fallback (`APPROVED: ...`) handles cases where the model doesn't produce valid JSON.

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

All options are set under `architectPlugin` in `opencode.json`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxRounds` | `number` | `3` | Maximum debate rounds before stopping |
| `retainSessions` | `boolean` | `false` | Keep sub-sessions after debate ends |
| `timeoutMs` | `number` | `120000` | Per-prompt timeout in milliseconds |
| `proposerPersona` | `string` | built-in | Custom system prompt for Architect-1 |
| `criticPersona` | `string` | built-in | Custom system prompt for Architect-2 |

**Example — custom personas:**

```json
{
  "architectPlugin": {
    "maxRounds": 5,
    "timeoutMs": 180000,
    "proposerPersona": "You are a pragmatic backend engineer who values simplicity...",
    "criticPersona": "You are a strict API designer who enforces REST conventions..."
  }
}
```

## File Structure

```
opencode-architect-plugin/
├── opencode.json          # Plugin registration and configuration
├── package.json           # Dependencies (@opencode-ai/plugin)
├── tsconfig.json          # TypeScript configuration
└── src/
    ├── index.ts           # Plugin entry point — registers the architect tool
    ├── debate-engine.ts   # Core debate loop, session lifecycle, transcript saving
    ├── prompts.ts         # Architect personas and prompt builders
    ├── consensus.ts       # Verdict parsing and consensus detection
    ├── context.ts         # Project context gathering via ctx.$
    └── types.ts           # Shared TypeScript interfaces
```

### Module Responsibilities

**`src/types.ts`**
Core interfaces shared across modules:
- `PluginConfig` — runtime configuration
- `Verdict` — structured critic output (`approved`, `score`, `key_issues`)
- `DialogueRound` — one round of proposal + critique + verdict
- `ProtocolResult` — final output of a debate session

**`src/context.ts`**
Gathers project context before the debate starts using Bun shell (`ctx.$`). Reads file tree, config files, and entry point source to give architects grounding in the actual codebase.

**`src/consensus.ts`**
Parses structured `json:verdict` fenced blocks from the Critic's responses. Falls back to keyword detection (`APPROVED: ...`) for resilience. Consensus requires `approved: true` AND `score >= 7`.

**`src/prompts.ts`**
Defines the default Proposer and Critic personas as inline constants (no external files). Exports prompt builder functions for each phase of the debate and formatters for both condensed output and full transcripts.

**`src/debate-engine.ts`**
The core protocol loop:
- Creates two peer sub-sessions (`parentID` links them to the active session)
- Drives the Propose → Critique → Revise loop
- Handles 120s timeout per prompt with abort signal support
- Cleans up sub-sessions in `try/finally` (unless `retainSessions: true`)
- Saves the full transcript via `Bun.write()`

**`src/index.ts`**
Plugin entry point. Registers the `architect` tool using `tool()` from `@opencode-ai/plugin`. Reads `architectPlugin` overrides from `opencode.json` via the `config` hook.

## Transcript Format

Transcripts are saved to `.opencode/architect-debates/{timestamp}.md`:

```markdown
# Architect Debate Transcript

**Vision**: Design a plugin system for a CLI tool
**Rounds**: 2
**Consensus**: Yes — Approved (score: 8/10)

---

## Round 1

### Proposer
[Architect-1's initial proposal...]

### Critic
[Architect-2's critique...]

**Verdict**: NOT APPROVED (6/10)
**Issues**: Missing error boundaries; plugin isolation not addressed

---

## Round 2

### Proposer
[Architect-1's revised proposal...]

### Critic
[Architect-2's final review...]

**Verdict**: APPROVED (8/10)

---
```

## Requirements

- [opencode](https://github.com/anomalyco/opencode) installed
- [Bun](https://bun.sh) runtime
- An AI model configured in opencode (Claude recommended)

## Version

**v1** — debate protocol only. The plugin facilitates the design phase; implementation proceeds naturally in the main session after consensus is returned.
