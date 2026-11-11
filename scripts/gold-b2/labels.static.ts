import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../test/repo.ts";
import { SHEET_COLUMNS } from "./draw.ts";
import {
  agreedSample,
  guideNormalise,
  NOT_CHECKED,
  parseCsv,
  passesFor,
  SAMPLED,
  type Funded,
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

function table(path: string, columns: readonly string[]) {
  const [header, ...rows] = parseCsv(readRepoFile(path));
  expect(header).toEqual(columns);
  return rows.map((row) => {
    expect(row).toHaveLength(columns.length);
    return Object.fromEntries(
      columns.map((column, i) => [column, row[i] ?? ""]),
    );
  });
}

const FUNDED = new Set(["yes", "no", "unclear"]);
const list = (cell: string | undefined): string[] =>
  cell === undefined || cell === "" ? [] : cell.split("; ");
const funded = (cell: string | undefined): Funded => {
  if (cell === "yes" || cell === "no" || cell === "unclear") return cell;
  throw new Error(`funded is ${String(cell)}`);
};

const proposed = table(PROPOSED, SHEET_COLUMNS);
const passRows = table(PASSES, PASSES_COLUMNS);
const passesOf = (pmcid: string): [Pass, Pass] => {
  const mine = passRows.filter((row) => row.pmcid === pmcid);
  expect(mine.map((row) => row.pass)).toEqual(["1", "2"]);
  const [one, two] = mine.map((row): Pass => ({
    funded: funded(row.funded),
    references: list(row.references_normalised),
    unsure: row.unsure === "yes",
  }));
  if (one === undefined || two === undefined) throw new Error(pmcid);
  return [one, two];
};

// The references a row lists, as written, normalise as the guide says.
function expectNormalised(
  written: string | undefined,
  normalised: string | undefined,
) {
  expect(list(written).map(guideNormalise)).toEqual(list(normalised));
}

describe("gold set B2's proposed labels", () => {
  it("records the labeller, the versions, the models and the check's seed", () => {
    expect(labels).toBeDefined();
    expect(labels?.checkSize).toBe(10);
  });

  it("lists the sample's papers in order, in the sheet and the proposals", () => {
    for (const rows of [proposed, table(SHEET, SHEET_COLUMNS)]) {
      expect(rows.map((row) => row.pmcid)).toEqual(recorded.papers);
      for (const row of rows) {
        expect(row.europe_pmc).toBe(
          `https://europepmc.org/article/PMC/${String(row.pmcid)}`,
        );
      }
    }
  });

  it("keeps both passes' labels for every paper", () => {
    expect(passRows).toHaveLength(2 * recorded.papers.length);
    for (const row of passRows) {
      expect(FUNDED.has(row.funded ?? "")).toBe(true);
      expect(["yes", "no"]).toContain(row.unsure);
      expectNormalised(row.references_as_written, row.references_normalised);
    }
  });

  it("proposes the first pass's labels, with how the passes compared", () => {
    for (const row of proposed) {
      const pmcid = row.pmcid ?? "";
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
      const [one, two] = passesOf(row.pmcid ?? "");
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
      pmcid: row.pmcid ?? "",
      reasons: list(row.flag).filter(
        (flag) => flag !== SAMPLED && flag !== NOT_CHECKED,
      ),
    }));
    const drawn = new Set(
      agreedSample(rows, labels?.checkSeed ?? 0, labels?.checkSize),
    );
    for (const row of proposed) {
      const flags = list(row.flag);
      if (drawn.has(row.pmcid ?? "")) expect(flags).toEqual([SAMPLED]);
      else if (flags.includes(SAMPLED))
        throw new Error(`${String(row.pmcid)} sampled`);
      else if (flags.length === 0 || flags.includes(NOT_CHECKED)) {
        expect(flags).toEqual([NOT_CHECKED]);
      }
    }
    expect(drawn.size).toBe(labels?.checkSize);
  });
});
