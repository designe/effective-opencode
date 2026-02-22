import type { DialogueRound, Verdict } from "./types";

export const PROPOSER_PERSONA = `You are Architect-1 (the Proposer) in a pair programming design session.

Your role:
 - Propose clear, structured software architectures based on the lead's vision
 - Address critiques thoughtfully in revisions — don't be defensive, integrate good feedback
 - Use concrete TypeScript code examples where they clarify the design
 - You may edit project files directly when it helps validate or prototype the design
 - Structure your proposals with: Overview, Components, Interfaces, Data Flow, File Structure

End EVERY response with a verdict block for self-assessment:
\`\`\`json:verdict
{ "approved": false, "score": 0, "key_issues": ["N/A — proposer does not self-approve"] }
\`\`\``;

export const CRITIC_PERSONA = `You are Architect-2 (the Critic) in a pair programming design session.

Your role:
- Critically evaluate proposed architectures for quality and correctness
- Focus on: missing edge cases, over-engineering, unclear interfaces, scalability issues, simpler alternatives
- Be constructive — explain WHY something is problematic and suggest concrete fixes
- Don't nitpick — focus on structural/architectural issues that actually matter
 - When implementation-relevant issues are identified, call out exact files and expected diffs

Set approved:true ONLY when score >= 7 and no critical issues remain.

End EVERY response with a verdict block:
\`\`\`json:verdict
{ "approved": true/false, "score": 1-10, "key_issues": ["list", "of", "issues"] }
\`\`\``;

export function buildInitialProposerPrompt(
  persona: string,
  projectContext: string,
  vision: string,
): string {
  return `${persona}

## Project Context
${projectContext}

## Lead's Vision
${vision}

Propose an architecture/design for this. Be concrete and actionable.`;
}

export function buildInitialCritiquePrompt(
  persona: string,
  projectContext: string,
  proposal: string,
): string {
  return `${persona}

## Project Context
${projectContext}

## Architect-1's Proposal
${proposal}

Critically review this proposal. Identify strengths, weaknesses, and suggest improvements.`;
}

export function buildCriticPreparationPrompt(
  persona: string,
  projectContext: string,
  vision: string,
): string {
  return `${persona}

## Project Context
${projectContext}

## Lead's Vision
${vision}

Before the proposal arrives, prepare your review plan.

Return:
1. Critical evaluation checklist
2. Likely risk hotspots to inspect
3. Assumptions/questions to validate

Do NOT approve/reject yet. This is preparation only.`;
}

export function buildCritiquePrompt(
  proposal: string,
  round: number,
  maxRounds: number,
): string {
  const urgency =
    round === maxRounds
      ? "\n\nThis is the FINAL round. Either APPROVE the design or give your most critical remaining feedback."
      : "";
  return `## Architect-1's Revised Proposal (Round ${round})
${proposal}${urgency}

Review this revision. Has it addressed previous concerns?`;
}

export function buildRevisionPrompt(
  critique: string,
  verdict: Verdict | null,
  rounds: DialogueRound[],
  round: number,
): string {
  // Summarize old rounds if > 2 to manage context
  let summary = "";
  if (rounds.length > 2) {
    const oldRounds = rounds.slice(0, -2);
    const issuesList = oldRounds
      .flatMap((r) => r.verdict?.key_issues ?? [])
      .filter(Boolean);
    summary = `[Rounds 1-${oldRounds.length} summary: ${issuesList.length ? issuesList.join("; ") : "iterative refinement"}]\n\n`;
  }

  const issues = verdict?.key_issues?.length
    ? `\n\nKey issues to address:\n${verdict.key_issues.map((i) => `- ${i}`).join("\n")}`
    : "";

  return `${summary}## Architect-2's Critique (Round ${round})
${critique}${issues}

Revise your design addressing these points.`;
}

export function formatCondensedResult(
  finalDesign: string,
  consensus: boolean,
  summary: string,
  roundCount: number,
  transcriptPath?: string,
): string {
  const parts = [
    `## Architecture Design ${consensus ? "Consensus" : "Result"} (${roundCount} round${roundCount !== 1 ? "s" : ""})`,
    "",
    `**Status**: ${consensus ? `Consensus reached — ${summary}` : `No consensus after ${roundCount} rounds — ${summary}`}`,
    "",
    "### Final Design",
    finalDesign,
  ];

  if (transcriptPath) {
    parts.push("", `_Full debate transcript: ${transcriptPath}_`);
  }

  return parts.join("\n");
}

export function formatFullTranscript(
  vision: string,
  rounds: DialogueRound[],
  consensus: boolean,
  summary: string,
): string {
  const parts = [
    "# Architect Debate Transcript",
    "",
    `**Vision**: ${vision}`,
    `**Rounds**: ${rounds.length}`,
    `**Consensus**: ${consensus ? `Yes — ${summary}` : "No"}`,
    "",
    "---",
    "",
  ];

  for (const round of rounds) {
    parts.push(
      `## Round ${round.round}`,
      "",
      "### Proposer",
      round.proposal,
      "",
      "### Critic",
      round.critique,
      "",
    );
    if (round.verdict) {
      parts.push(
        `**Verdict**: ${round.verdict.approved ? "APPROVED" : "NOT APPROVED"} (${round.verdict.score}/10)`,
      );
      if (round.verdict.key_issues.length) {
        parts.push(
          `**Issues**: ${round.verdict.key_issues.join("; ")}`,
        );
      }
      parts.push("");
    }
    parts.push("---", "");
  }

  return parts.join("\n");
}
