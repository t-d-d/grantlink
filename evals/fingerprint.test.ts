import { describe, expect, it } from "vitest";
import { fingerprint, INPUTS } from "./fingerprint.ts";

const trees = Object.fromEntries(
  INPUTS.map((path, i) => [path, String(i).repeat(40)]),
);

describe("the eval's fingerprint", () => {
  it("covers the extraction, the eval, its workflow and the lockfile", () => {
    expect(INPUTS).toEqual([
      "src/extract",
      "evals",
      ".github/workflows/eval.yml",
      "package-lock.json",
    ]);
  });

  it("is a SHA-256 of the inputs' git hashes", () => {
    expect(fingerprint(trees)).toMatch(/^[0-9a-f]{64}$/u);
    expect(fingerprint({ ...trees })).toBe(fingerprint(trees));
  });

  it.each(INPUTS)("changes when %s changes", (path) => {
    expect(fingerprint({ ...trees, [path]: "f".repeat(40) })).not.toBe(
      fingerprint(trees),
    );
  });

  it("refuses an input it has no hash for", () => {
    const rest = { ...trees };
    delete rest.evals;
    expect(() => fingerprint(rest)).toThrow(/evals/u);
  });
});
