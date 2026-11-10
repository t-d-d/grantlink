import { describe, expect, it } from "vitest";
import { tiers } from "./tiers.ts";
import { readRepoFile, repoFiles } from "./repo.ts";

// The PMCID pattern, the batching helper and a title's tags each have one
// definition, so copies cannot drift apart (#47, #639).
const code = repoFiles().filter(
  (path) =>
    (path.startsWith("src/") || path.startsWith("evals/")) &&
    /\.[cm]?[jt]s$/u.test(path) &&
    !tiers.some((tier) => path.endsWith(tier.suffix)),
);

describe("one definition of each shared helper", () => {
  it("finds the code", () => {
    expect(code).toContain("src/shared/pmcid.ts");
    expect(code).toContain("src/shared/batches.ts");
    expect(code).toContain("src/title.ts");
  });

  it.each(code.filter((path) => path !== "src/shared/pmcid.ts"))(
    "%s writes no PMCID pattern of its own",
    (path) => {
      expect(readRepoFile(path)).not.toMatch(/PMC\\d/u);
    },
  );

  it.each(code.filter((path) => path !== "src/shared/batches.ts"))(
    "%s writes no batching helper of its own",
    (path) => {
      expect(readRepoFile(path)).not.toMatch(/Math\.ceil\([^)]*\.length/u);
    },
  );

  // A title's inline tags are named, split and paired in src/title.ts
  // alone, so plainTitle and the page cannot pair them by rules that drift
  // apart (#639).
  it.each(code.filter((path) => path !== "src/title.ts"))(
    "%s names no title tags of its own",
    (path) => {
      // A list of the names, in a pattern or an array, in any order.
      expect(readRepoFile(path)).not.toMatch(
        /\bsu[pb]\|\w|\w\|su[pb]\b|["'`]su[pb]["'`]/u,
      );
    },
  );
});
