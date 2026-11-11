import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readRepoFile } from "../../test/repo.ts";
import { SHEET_COLUMNS } from "./draw.ts";
import {
  agreedSample,
  guideNormalise,
  NOT_CHECKED,
  parseCsv,
  passesFor,
  SAMPLE_SIZE,
  SAMPLED,
  type Pass,
} from "./flags.ts";
import {
  PASSES,
  PASSES_COLUMNS,
  PROPOSED,
  record,
  RECORD,
  SHEET,
} from "./record.ts";

// Gold set B2's proposed labels and flags (#700): every paper has both
// passes' labels, the proposals say why each row is checked, and the
// random check of the other rows is the one the recorded seed draws.

const recorded = record.parse(JSON.parse(readRepoFile(RECORD)));
const labels = recorded.labels;

// A CSV file's rows, by column, once its header is the one expected.
function table(path: string, columns: readonly string[]): unknown[] {
  const [header, ...rows] = parseCsv(readRepoFile(path));
  if (header?.join(",") !== columns.join(",")) {
    throw new Error(`${path}'s header is not ${columns.join(",")}`);
  }
  return rows.map((row, i) => {
    if (row.length !== columns.length) {
      throw new Error(`${path}'s row ${String(i + 2)} has the wrong cells`);
    }
    return Object.fromEntries(columns.map((column, j) => [column, row[j]]));
  });
}

const FUNDED = z.enum(["yes", "no", "unclear"]);
const proposedRow = z
  .object({
    pmcid: z.string(),
    europe_pmc: z.string(),
    funded: FUNDED,
    references_as_written: z.string(),
    references_normalised: z.string(),
    note: z.string(),
    passes: z.string(),
    flag: z.string(),
    look_in: z.string(),
    checked: z.string(),
  })
  .strict();
// The owner's sheet, which may have a row not yet labelled.
const sheetRow = proposedRow.extend({ funded: FUNDED.or(z.literal("")) });
const passRow = z
  .object({
    pmcid: z.string(),
    pass: z.enum(["1", "2"]),
    funded: FUNDED,
    references_as_written: z.string(),
    references_normalised: z.string(),
    unsure: z.enum(["yes", "no"]),
  })
  .strict();

const list = (cell: string): string[] => (cell === "" ? [] : cell.split("; "));

const proposed = z.array(proposedRow).parse(table(PROPOSED, SHEET_COLUMNS));
const sheet = z.array(sheetRow).parse(table(SHEET, SHEET_COLUMNS));
const passRows = z.array(passRow).parse(table(PASSES, PASSES_COLUMNS));
const passesOf = (pmcid: string): [Pass, Pass] => {
  const mine = passRows.filter((row) => row.pmcid === pmcid);
  expect(mine.map((row) => row.pass)).toEqual(["1", "2"]);
  const [one, two] = mine.map((row): Pass => ({
    funded: row.funded,
    references: list(row.references_normalised),
    unsure: row.unsure === "yes",
  }));
  if (one === undefined || two === undefined) throw new Error(pmcid);
  return [one, two];
};

// The references a row lists, as written, normalise as the guide says.
function expectNormalised(written: string, normalised: string) {
  expect(list(written).map(guideNormalise)).toEqual(list(normalised));
}

describe("gold set B2's proposed labels", () => {
  it("records the labeller, the versions, the models and the check's seed", () => {
    expect(labels).toBeDefined();
    expect(labels?.checkSize).toBe(SAMPLE_SIZE);
  });

  it("lists the sample's papers in order, in the sheet and the proposals", () => {
    for (const rows of [proposed, sheet]) {
      expect(rows.map((row) => row.pmcid)).toEqual(recorded.papers);
      for (const row of rows) {
        expect(row.europe_pmc).toBe(
          `https://europepmc.org/article/PMC/${row.pmcid}`,
        );
      }
    }
  });

  it("keeps the columns the owner leaves alone as the proposals have them", () => {
    const kept = (row: z.infer<typeof sheetRow>) => [
      row.pmcid,
      row.europe_pmc,
      row.passes,
      row.flag,
      row.look_in,
    ];
    expect(sheet.map(kept)).toEqual(proposed.map(kept));
  });

  it("keeps both passes' labels for every paper", () => {
    expect(passRows).toHaveLength(2 * recorded.papers.length);
    for (const row of passRows) {
      expectNormalised(row.references_as_written, row.references_normalised);
    }
  });

  it("proposes the first pass's labels, with how the passes compared", () => {
    for (const row of proposed) {
      const pmcid = row.pmcid;
      const [one, two] = passesOf(pmcid);
      const first = passRows.find((p) => p.pmcid === pmcid && p.pass === "1");
      expect(row.funded).toBe(one.funded);
      expect(row.references_as_written).toBe(first?.references_as_written);
      expectNormalised(row.references_as_written, row.references_normalised);
      expect(row.passes).toBe(passesFor([one, two]));
      expect(row.checked).toBe("");
      if (row.funded === "yes") expect(row.look_in).not.toBe("");
    }
  });

  it("flags every row by #700's reasons, and agrees with the passes", () => {
    const models = labels?.models ?? [];
    const allowed = new Set([
      "passes differ",
      "a pass was unsure",
      "differs from the rules",
      ...models.map((model) => `differs from ${model} alone`),
    ]);
    for (const row of proposed) {
      const [one, two] = passesOf(row.pmcid);
      const reasons = list(row.flag).filter(
        (flag) => flag !== SAMPLED && flag !== NOT_CHECKED,
      );
      for (const reason of reasons) expect(allowed.has(reason)).toBe(true);
      expect(reasons.includes("passes differ")).toBe(
        passesFor([one, two]).includes("differed"),
      );
      expect(reasons.includes("a pass was unsure")).toBe(
        one.unsure || two.unsure,
      );
    }
  });

  it("draws the random check from the unflagged rows with the recorded seed", () => {
    const rows = proposed.map((row) => ({
      pmcid: row.pmcid,
      reasons: list(row.flag).filter(
        (flag) => flag !== SAMPLED && flag !== NOT_CHECKED,
      ),
    }));
    const drawn = new Set(
      agreedSample(rows, labels?.checkSeed ?? 0, labels?.checkSize),
    );
    for (const row of proposed) {
      const flags = list(row.flag);
      if (drawn.has(row.pmcid)) expect(flags).toEqual([SAMPLED]);
      else if (flags.includes(SAMPLED)) throw new Error(`${row.pmcid} sampled`);
      else if (flags.length === 0 || flags.includes(NOT_CHECKED)) {
        expect(flags).toEqual([NOT_CHECKED]);
      }
    }
    expect(drawn.size).toBe(labels?.checkSize);
  });
});
