import { describe, expect, it } from "vitest";
import { goldB, goldB2, goldBLabels } from "../evals/gold.ts";
import { parseCsv } from "../scripts/gold-b2/flags.ts";
import { PROPOSED, record, RECORD, SHEET } from "../scripts/gold-b2/record.ts";
import { readRepoFile } from "./repo.ts";

// Gold set B2's labels (#695, #702): the owner's checked labels for each
// paper drawn for it, ids and normalised references only, and a note of
// how they were made and checked.

const drawn = record.parse(JSON.parse(readRepoFile(RECORD))).papers;

// Each row of a sheet by its column names.
function rows(path: string): Record<string, string>[] {
  const [header = [], ...body] = parseCsv(readRepoFile(path));
  return body.map((row) =>
    Object.fromEntries(header.map((column, i) => [column, row[i] ?? ""])),
  );
}

const list = (cell: string | undefined): string[] =>
  cell === undefined || cell === "" ? [] : cell.split("; ");

const sheet = rows(SHEET);
const proposed = rows(PROPOSED);

describe("fitness: evals/gold-b2.json holds 100 papers, ids and references only, and none is in gold set B (evals.md)", () => {
  it("labels each of the 100 papers drawn for gold set B2, once", () => {
    const labelled = goldB2.papers.map((paper) => paper.pmcid);
    expect(labelled).toHaveLength(100);
    expect(new Set(labelled).size).toBe(labelled.length);
    expect([...labelled].sort()).toEqual([...drawn].sort());
  });

  it("holds ids and references only", () => {
    const raw: unknown = JSON.parse(readRepoFile("evals/gold-b2.json"));
    expect(goldBLabels.parse(raw)).toEqual(raw);
  });

  it("has no paper in gold set B", () => {
    const inB = new Set(goldB.papers.map((paper) => paper.pmcid));
    expect(goldB2.papers.filter((paper) => inB.has(paper.pmcid))).toEqual([]);
  });
});

describe("gold set B2's labels", () => {
  it("are the owner's checked sheet's normalised references", () => {
    const fromSheet = new Map(
      sheet.map((row) => [row.pmcid, list(row.references_normalised)]),
    );
    for (const paper of goldB2.papers) {
      expect(paper.references).toEqual(fromSheet.get(paper.pmcid));
    }
  });

  it("count every row of the sheet as checked or accepted as proposed", () => {
    expect(sheet.every((row) => row.checked !== "")).toBe(true);
  });

  it("say a Claude model proposed them, how the owner checked them, and how many the owner changed", () => {
    const changed = sheet.filter((row, i) => {
      const was = proposed[i];
      return (
        was?.pmcid !== row.pmcid ||
        was?.funded !== row.funded ||
        was?.references_normalised !== row.references_normalised
      );
    }).length;
    const checked = sheet.filter((row) =>
      (row.checked ?? "").startsWith("y"),
    ).length;
    const { about } = goldB2;
    expect(about).toMatch(/Claude Opus/u);
    expect(about).toMatch(/proposed/u);
    expect(about).toContain(`The owner checked ${String(checked)} papers`);
    expect(about).toContain(
      `The owner changed ${String(changed)} of the 100 labels against docs/gold-set-b2-proposed.csv`,
    );
    expect(about).toContain("#695");
    expect(about).toContain("#701");
  });
});
