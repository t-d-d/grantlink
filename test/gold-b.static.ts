import { describe, expect, it } from "vitest";
import { z } from "zod";
import { goldB } from "../evals/gold.ts";
import { readRepoFile } from "./repo.ts";

// Gold set B's labels (#23, #175): one entry for each paper drawn for it,
// and a note of how the labels were made.

const drawn = z
  .object({ papers: z.array(z.object({ pmcid: z.string() })) })
  .parse(JSON.parse(readRepoFile("docs/gold-set-b-sample.json")))
  .papers.map((paper) => paper.pmcid);

describe("gold set B's labels", () => {
  it("label each of the 100 papers drawn for gold set B, once", () => {
    const labelled = goldB.papers.map((paper) => paper.pmcid);
    expect(labelled).toHaveLength(100);
    expect(new Set(labelled).size).toBe(labelled.length);
    expect([...labelled].sort()).toEqual([...drawn].sort());
  });

  it("say a model proposed them, the owner checked them, and how many the owner changed", () => {
    expect(goldB.about).toMatch(/proposed/u);
    expect(goldB.about).toMatch(/owner checked/u);
    expect(goldB.about).toMatch(/owner changed \d+ of the 100 labels/u);
    expect(goldB.about).toContain("#175");
  });
});
