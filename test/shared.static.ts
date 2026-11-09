import { describe, expect, it } from "vitest";
import { tiers } from "./tiers.ts";
import { readRepoFile, repoFiles } from "./repo.ts";

// The PMCID pattern and the batching helper each have one definition, so
// copies cannot drift apart (#47).
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
});
