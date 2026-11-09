import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readRepoFile } from "./repo.ts";

// Governor merges a pull request its review passes (#181). What only the
// owner should judge waits for them through `humanOnly`. The review judges
// complexity from the description's "Adds / removes" net line, and reads no
// source files, so `quote` stays unset.
const config = z
  .object({
    prReview: z.object({
      merge: z.boolean().optional(),
      humanOnly: z
        .array(z.object({ glob: z.string(), reason: z.string().min(1) }))
        .optional(),
      quote: z.unknown().optional(),
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

  it("leaves prReview.quote unset", () => {
    expect(config.quote).toBeUndefined();
  });

  it("has a checklist test for complexity and value that no description edit can pass", () => {
    const skill = readRepoFile(".claude/skills/pr-review/SKILL.md");
    expect(skill).toMatch(/complexity/iu);
    expect(skill).toMatch(/Adds \/ removes/u);
    expect(skill).toMatch(/net\s+line/u);
    expect(skill).not.toMatch(/prReview\.quote/u);
    expect(skill).toMatch(/no\s+edit\s+to\s+the\s+description\s+can\s+make/iu);
    expect(skill).not.toMatch(/it is empty here/u);
  });
});
