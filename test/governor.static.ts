import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deploy } from "./app.ts";
import { readRepoFile } from "./repo.ts";

// Governor merges a pull request its review passes (#181). What only the
// owner should judge waits for them through `humanOnly`. The review judges
// complexity from the description's "Adds / removes" net line, and reads no
// source files, so `quote` stays unset.
const config = z
  .object({
    prReview: z.object({
      merge: z.boolean().optional(),
      requireChecks: z.array(z.string()).optional(),
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

  // A pass merges, so the review must wait for the eval as well as the
  // gate: a pull request whose report is below a gating floor must not
  // merge (deploy-gates.md).
  it("waits for the gate and the eval before it merges", () => {
    expect(config.requireChecks ?? []).toEqual(
      expect.arrayContaining(["gate", "eval"]),
    );
  });

  it("holds what only the owner should judge, each with its reason", () => {
    expect((config.humanOnly ?? []).map(({ glob }) => glob).sort()).toEqual(
      [
        ".claude/**",
        ".github/**",
        "CLAUDE.md",
        "docs/constraints/**",
        "evals/**",
        "infra/**",
        "package-lock.json",
        "package.json",
        "scripts/**",
        "serverless.yml",
        "**/*.live.ts",
        "test/tiers.ts",
        "vitest.config.ts",
      ].sort(),
    );
  });

  // The review reads no source files, so the paths that change what ships
  // wait for the owner too (#183): a merge deploys `serverless.yml`, the
  // eval set's floors decide what may deploy, and the package files hold
  // the dependencies. The deploy job runs `scripts/**` with the deploy
  // role's credentials, so they wait for the owner too (#203). The live
  // tier holds no credentials (#311), but it runs in the deploy job, which
  // may ask GitHub for a token the deploy role trusts, so it waits as well
  // (#410). The live tier is every `*.live.ts` file that `vitest.config.ts`
  // and `test/tiers.ts` pick out, so all three are held.
  it("names every human-only path in CLAUDE.md and the review checklist", () => {
    const paths = (config.humanOnly ?? []).map(({ glob }) =>
      glob.replace(/\*\*$/u, ""),
    );
    const claude = readRepoFile("CLAUDE.md");
    const owner = /^- A pull request waits for the owner when.*$/mu.exec(
      claude,
    );
    const checklist = readRepoFile(".claude/skills/pr-review/SKILL.md");
    const test8 =
      /^8\. \*\*No changed file is on the human-only list\.[\s\S]*?(?=^9\. )/mu.exec(
        checklist,
      );
    expect(owner, "CLAUDE.md's waits-for-the-owner line").not.toBeNull();
    expect(test8, "the checklist's test 8").not.toBeNull();
    expect(paths.length).toBeGreaterThan(0);
    // Both ways: each list names exactly the config's paths, so a path
    // dropped from the config cannot stay named as waiting in the prose.
    const named = (text: string | undefined): string[] =>
      [...(text ?? "").matchAll(/`([^`]+)`/gu)]
        .map(([, path]) => path ?? "")
        .filter(
          (path) =>
            !["prReview.humanOnly", ".github/governor.json"].includes(path),
        )
        .sort();
    expect(named(owner?.[0])).toEqual([...paths].sort());
    expect(named(test8?.[0])).toEqual([...paths].sort());
  });

  // The live step holds none of the deploy role's credentials (#311), but
  // it runs in a job with `id-token: write`, and the deploy role trusts
  // that job's environment. So code in the live tier could ask GitHub for a
  // token and assume the role, and that is why its paths wait (#410).
  it("gives the live tier's paths the reason that holds today", () => {
    const live = ["**/*.live.ts", "test/tiers.ts", "vitest.config.ts"];
    const job = Object.values(deploy.jobs).find((candidate) =>
      (candidate.steps ?? []).some((step) =>
        step.run?.includes("npm run test:live"),
      ),
    );
    expect(job?.environment).toBe("prod");
    expect(job?.permissions?.["id-token"]).toBe("write");
    const reasons = (config.humanOnly ?? [])
      .filter(({ glob }) => live.includes(glob))
      .map(({ reason }) => reason);
    expect(reasons).toHaveLength(live.length);
    for (const reason of reasons) {
      expect(reason).toMatch(/token/u);
      expect(reason).not.toMatch(/credentials/u);
    }
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
  });
});
