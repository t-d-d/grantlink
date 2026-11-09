import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readRepoFile } from "./repo.ts";

// Governor merges a pull request its review passes (#181). What only the
// owner should judge waits for them through `humanOnly`, and the review
// reads every modified file under `quote` whole, so it can judge whether
// the change keeps complexity level.
const config = z
  .object({
    prReview: z.object({
      merge: z.boolean().optional(),
      humanOnly: z
        .array(z.object({ glob: z.string(), reason: z.string().min(1) }))
        .optional(),
      quote: z.array(z.string()).optional(),
    }),
  })
  .parse(JSON.parse(readRepoFile(".github/governor.json"))).prReview;

describe("governor merges pull requests its review passes", () => {
  it("has prReview.merge on", () => {
    expect(config.merge).not.toBe(false);
  });

  it("holds what only the owner should judge, each with its reason", () => {
    expect((config.humanOnly ?? []).map(({ glob }) => glob).sort()).toEqual(
      [
        ".claude/**",
        ".github/**",
        "CLAUDE.md",
        "docs/constraints/**",
        "infra/**",
      ].sort(),
    );
  });

  it("quotes the code it judges", () => {
    expect([...(config.quote ?? [])].sort()).toEqual(
      ["evals/**", "scripts/**", "serverless.yml", "src/**", "test/**"].sort(),
    );
  });

  it("has a checklist test for complexity and value that no description edit can pass", () => {
    const skill = readRepoFile(".claude/skills/pr-review/SKILL.md");
    expect(skill).toMatch(/complexity/iu);
    expect(skill).toMatch(/no edit to the description can make/iu);
    expect(skill).not.toMatch(/it is empty here/u);
  });
});
