import { describe, expect, it } from "vitest";
import { goldB } from "../../evals/gold.ts";
import { readRepoFile } from "../../test/repo.ts";
import { record, RECORD } from "./record.ts";
import { upTo } from "./draw.ts";

const recorded = record.parse(JSON.parse(readRepoFile(RECORD)));

describe("gold set B2's recorded sample", () => {
  it("holds the plan's 100 papers, once each", () => {
    expect(recorded.size).toBe(100);
    expect(recorded.papers).toHaveLength(recorded.size);
    expect(new Set(recorded.papers).size).toBe(recorded.papers.length);
    expect(recorded.population).toBeGreaterThan(recorded.size);
  });

  it("holds no paper in gold set B", () => {
    const inB = new Set(goldB.papers.map(({ pmcid }) => pmcid));
    expect(inB.size).toBe(100);
    expect(recorded.papers.filter((pmcid) => inB.has(pmcid))).toEqual([]);
  });

  it("records a search cut off the day before it ran", () => {
    expect(recorded.query.endsWith(upTo("", recorded.ranOn).slice(2))).toBe(
      true,
    );
  });
});
