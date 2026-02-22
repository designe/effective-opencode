import { describe, test, expect } from "bun:test";
import {
  PROPOSER_PERSONA,
  CRITIC_PERSONA,
  buildInitialProposerPrompt,
  buildInitialCritiquePrompt,
  buildCriticPreparationPrompt,
  buildCritiquePrompt,
  buildRevisionPrompt,
  formatCondensedResult,
  formatFullTranscript,
} from "../prompts";
import type { DialogueRound, Verdict } from "../types";

describe("prompts", () => {
  describe("buildInitialProposerPrompt", () => {
    test("should build prompt with persona, context, and vision", () => {
      const persona = "You are a helpful architect";
      const context = "Project: test project";
      const vision = "Design a REST API";

      const prompt = buildInitialProposerPrompt(persona, context, vision);

      expect(prompt).toContain(persona);
      expect(prompt).toContain(context);
      expect(prompt).toContain(vision);
      expect(prompt).toContain("Project Context");
      expect(prompt).toContain("Lead's Vision");
    });
  });

  describe("buildInitialCritiquePrompt", () => {
    test("should build critique prompt with proposal", () => {
      const persona = "You are a critical reviewer";
      const context = "Project context";
      const proposal = "This is my proposal...";

      const prompt = buildInitialCritiquePrompt(persona, context, proposal);

      expect(prompt).toContain(persona);
      expect(prompt).toContain(context);
      expect(prompt).toContain(proposal);
      expect(prompt).toContain("Architect-1's Proposal");
    });
  });

  describe("buildCriticPreparationPrompt", () => {
    test("should build critic preparation prompt with vision and context", () => {
      const persona = "You are a strict reviewer";
      const context = "Project context";
      const vision = "Build a plugin architecture";

      const prompt = buildCriticPreparationPrompt(persona, context, vision);

      expect(prompt).toContain(persona);
      expect(prompt).toContain(context);
      expect(prompt).toContain(vision);
      expect(prompt).toContain("prepare your review plan");
      expect(prompt).toContain("Do NOT approve/reject yet");
    });
  });

  describe("buildCritiquePrompt", () => {
    test("should build round-specific critique prompt", () => {
      const proposal = "Revised proposal...";

      const prompt = buildCritiquePrompt(proposal, 2, 3);

      expect(prompt).toContain("Round 2");
      expect(prompt).toContain(proposal);
    });

    test("should add urgency message on final round", () => {
      const proposal = "Final proposal...";
      const maxRounds = 3;

      const prompt = buildCritiquePrompt(proposal, maxRounds, maxRounds);

      expect(prompt).toContain("FINAL round");
    });

    test("should not add urgency on non-final round", () => {
      const proposal = "Proposal...";

      const prompt = buildCritiquePrompt(proposal, 1, 3);

      expect(prompt).not.toContain("FINAL round");
    });
  });

  describe("buildRevisionPrompt", () => {
    test("should build revision prompt with critique", () => {
      const critique = "This needs improvement";
      const verdict: Verdict = {
        approved: false,
        score: 5,
        key_issues: ["Issue 1", "Issue 2"],
      };
      const rounds: DialogueRound[] = [];

      const prompt = buildRevisionPrompt(critique, verdict, rounds, 1);

      expect(prompt).toContain(critique);
      expect(prompt).toContain("Issue 1");
      expect(prompt).toContain("Issue 2");
      expect(prompt).toContain("Key issues to address");
    });

    test("should handle null verdict", () => {
      const critique = "No verdict yet";
      const rounds: DialogueRound[] = [];

      const prompt = buildRevisionPrompt(critique, null, rounds, 1);

      expect(prompt).toContain(critique);
      expect(prompt).not.toContain("Key issues to address");
    });
  });

  describe("formatCondensedResult", () => {
    test("should format consensus result", () => {
      const design = "Final design content...";
      const summary = "Approved (score: 8/10)";

      const result = formatCondensedResult(design, true, summary, 2);

      expect(result).toContain("Consensus");
      expect(result).toContain("2 rounds");
      expect(result).toContain(design);
      expect(result).toContain(summary);
    });

    test("should format non-consensus result", () => {
      const design = "Final design content...";
      const summary = "Max rounds reached";

      const result = formatCondensedResult(design, false, summary, 3);

      expect(result).toContain("Result");
      expect(result).toContain("No consensus");
      expect(result).toContain("3 rounds");
    });

    test("should include transcript path when provided", () => {
      const result = formatCondensedResult(
        "Design",
        true,
        "Summary",
        1,
        ".opencode/debates/123.md"
      );

      expect(result).toContain(".opencode/debates/123.md");
    });

    test("should handle singular round", () => {
      const result = formatCondensedResult("Design", true, "Summary", 1);

      expect(result).toContain("1 round");
      expect(result).not.toContain("1 rounds");
    });
  });

  describe("formatFullTranscript", () => {
    test("should format complete transcript", () => {
      const vision = "Design a system";
      const rounds: DialogueRound[] = [
        {
          round: 1,
          proposal: "Initial proposal",
          critique: "Critique",
          verdict: { approved: false, score: 5, key_issues: ["issue"] },
        },
        {
          round: 2,
          proposal: "Revised proposal",
          critique: "Approved!",
          verdict: { approved: true, score: 8, key_issues: [] },
        },
      ];

      const transcript = formatFullTranscript(vision, rounds, true, "Approved");

      expect(transcript).toContain("Architect Debate Transcript");
      expect(transcript).toContain(vision);
      expect(transcript).toContain("**Rounds**: 2");
      expect(transcript).toContain("**Consensus**: Yes");
      expect(transcript).toContain("Round 1");
      expect(transcript).toContain("Round 2");
      expect(transcript).toContain("Initial proposal");
      expect(transcript).toContain("Revised proposal");
      expect(transcript).toContain("NOT APPROVED (5/10)");
      expect(transcript).toContain("APPROVED (8/10)");
    });

    test("should handle rounds without verdict", () => {
      const rounds: DialogueRound[] = [
        {
          round: 1,
          proposal: "Proposal",
          critique: "No structured verdict",
          verdict: null,
        },
      ];

      const transcript = formatFullTranscript("Vision", rounds, false, "No consensus");

      expect(transcript).toContain("**Consensus**: No");
    });
  });

  describe("personas", () => {
    test("PROPOSER_PERSONA should be defined", () => {
      expect(PROPOSER_PERSONA).toBeDefined();
      expect(PROPOSER_PERSONA.length).toBeGreaterThan(100);
      expect(PROPOSER_PERSONA).toContain("Proposer");
    });

    test("CRITIC_PERSONA should be defined", () => {
      expect(CRITIC_PERSONA).toBeDefined();
      expect(CRITIC_PERSONA.length).toBeGreaterThan(100);
      expect(CRITIC_PERSONA).toContain("Critic");
    });
  });
});
