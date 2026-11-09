import { describe, expect, it } from "vitest";
import type { FundingSections } from "../src/extract/rules.ts";
import { sameGrant, score } from "./score.ts";

const paper = (text: string[], awards: FundingSections["awards"] = []) => ({
  text,
  awards,
});

describe("matching a reference to Europe PMC's grant id", () => {
  it.each([
    ["C1234/A56789", "C1234/A56789"],
    ["C1234/A56789", "A56789"],
    ["A56789", "C1234/A56789"],
    ["A56789", "56789"],
    ["CTRQQR-2021/100010", "CTRQQR-2021\\100010"],
    ["CTRQQR-2021/100010", "ctrqqr-2021 / 100010"],
  ])("%s matches %s", (found, expected) => {
    expect(sameGrant(found, expected)).toBe(true);
  });

  it.each([
    ["C1234/A56789", "A56780"],
    ["A56789", "C1234"],
    ["CTRQQR-2021/100010", "100010"],
  ])("%s does not match %s", (found, expected) => {
    expect(sameGrant(found, expected)).toBe(false);
  });
});

describe("scoring the rules on the gold sets", () => {
  const texts = new Map([
    ["PMC1", paper(["Funded by Cancer Research UK (C1234/A56789)."])],
    ["PMC2", paper(["We thank Cancer Research UK for grant A11111."])],
    ["PMC3", paper(["Funded by the Wellcome Trust."])],
    ["PMC4", paper(["Cancer Research UK grant A22222 and C9/A33333."])],
  ]);

  it("scores recall on gold set A against Europe PMC's links, and names the papers it missed", () => {
    const result = score({
      texts,
      goldA: [
        { pmcid: "PMC1", grants: ["A56789"] },
        { pmcid: "PMC2", grants: ["A11111", "A99999"] },
        { pmcid: "PMC3", grants: ["A12345"] },
      ],
      goldB: [],
    });
    expect(result.rows["recall-a"]).toEqual({ score: 2 / 4, n: 3 });
    expect(result.missedA).toEqual(["PMC2", "PMC3"]);
  });

  it("scores precision and recall on gold set B against the owner's labels", () => {
    const result = score({
      texts,
      goldA: [],
      goldB: [
        { pmcid: "PMC1", references: ["C1234/A56789"] },
        { pmcid: "PMC3", references: [] },
        { pmcid: "PMC4", references: ["A22222"] },
      ],
    });
    // Found: C1234/A56789, A22222, C9/A33333. Two of three are true, and
    // both true references are found.
    expect(result.rows["precision-b"]).toEqual({ score: 2 / 3, n: 3 });
    expect(result.rows["recall-b"]).toEqual({ score: 1, n: 3 });
  });

  it("leaves a row with no gold papers empty, so it does not block", () => {
    const result = score({ texts: new Map(), goldA: [], goldB: [] });
    expect(result.rows["recall-a"].score).toBeNull();
    expect(result.rows["precision-b"].score).toBeNull();
    expect(result.rows["recall-b"].score).toBeNull();
    expect(result.rows["model-adds"].score).toBeNull();
    expect(result.rows["review-share"].score).toBeNull();
  });

  it("spends nothing, since only the rules run", () => {
    expect(score({ texts, goldA: [], goldB: [] }).rows.spend.score).toBe(0);
  });

  it("refuses to score a gold paper whose text is missing", () => {
    expect(() =>
      score({
        texts,
        goldA: [{ pmcid: "PMC9", grants: ["A1"] }],
        goldB: [],
      }),
    ).toThrow(/PMC9/u);
  });
});
