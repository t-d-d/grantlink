import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import goldB from "../../evals/gold-b.json" with { type: "json" };
import { record, RECORD, SHEET } from "./record.ts";
import { SHEET_COLUMNS, sheetCsv } from "./draw.ts";

const recorded = record.parse(JSON.parse(readFileSync(RECORD, "utf8")));

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

  it("records a search cut off at the day it ran", () => {
    expect(recorded.query).toMatch(
      new RegExp(`FIRST_PDATE:\\[1900-01-01 TO ${recorded.ranOn}\\]$`, "u"),
    );
  });
});

describe("gold set B2's labelling sheet", () => {
  it("lists the sample's papers with their links and empty label columns only", () => {
    const sheet = readFileSync(SHEET, "utf8");
    expect(sheet.split("\n")[0]).toBe(SHEET_COLUMNS.join(","));
    expect(sheet).toBe(sheetCsv(recorded.papers));
  });
});
