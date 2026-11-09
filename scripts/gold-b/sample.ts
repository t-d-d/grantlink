import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { europePmc, type EuropePmc } from "../../src/europepmc/client.ts";
import { pmcid as PMCID } from "../../src/shared/pmcid.ts";
import { draw, HARD_CASES, sheetCsv } from "./draw.ts";

// Draws gold set B's sample from Europe PMC with the plan recorded in
// docs/gold-set-b-sample.json, and checks it against the papers recorded
// there (#3). It reads Europe PMC through the service's own client, at its
// pace, and prints ids and counts only.
//
//   node scripts/gold-b/sample.ts           draw again and compare
//   node scripts/gold-b/sample.ts --write   record the draw and the sheet

const RECORD = "docs/gold-set-b-sample.json";
const SHEET = "docs/gold-set-b-sheet.csv";

const record = z
  .object({
    about: z.string(),
    base: z.string().min(1),
    seed: z.number().int(),
    size: z.number().int().positive(),
    perHardCase: z.number().int().positive(),
    hardCases: z.array(
      z.object({ name: z.enum(HARD_CASES), query: z.string().min(1) }).strict(),
    ),
    ranOn: z.iso.date().nullable(),
    population: z.number().int().nonnegative().nullable(),
    papers: z.array(
      z
        .object({
          pmcid: PMCID,
          year: z.string(),
          pickedFor: z.enum([...HARD_CASES, "year"]),
        })
        .strict(),
    ),
    sheetOrder: z.array(PMCID),
  })
  .strict();

const recorded = record.parse(JSON.parse(readFileSync(RECORD, "utf8")));
const client = europePmc();
// Europe PMC can take many seconds a request, so the draw says which
// paper it is reading, by id only.
const api: EuropePmc = {
  ...client,
  search: (cursor, selection, pageSize) => {
    console.error(`search page ${cursor.slice(0, 12)}`);
    return client.search(cursor, selection, pageSize);
  },
  fullText: (pmcid) => {
    console.error(`read ${pmcid}`);
    return client.fullText(pmcid);
  },
};
const drawn = await draw(api, recorded);

if (process.argv.includes("--write")) {
  const next = {
    ...recorded,
    ranOn: new Date().toISOString().slice(0, 10),
    population: drawn.population,
    papers: drawn.papers,
    sheetOrder: drawn.sheetOrder,
  };
  writeFileSync(RECORD, `${JSON.stringify(next, null, 2)}\n`);
  writeFileSync(SHEET, sheetCsv(drawn.sheetOrder));
  console.log(
    JSON.stringify({
      population: drawn.population,
      drawn: drawn.papers.length,
    }),
  );
} else {
  const want = recorded.papers.map(({ pmcid }) => pmcid);
  const got = drawn.papers.map(({ pmcid }) => pmcid);
  const missing = want.filter((pmcid) => !got.includes(pmcid));
  const extra = got.filter((pmcid) => !want.includes(pmcid));
  // A paper drawn again for another hard case or year is a change too.
  const before = new Map(
    recorded.papers.map((paper) => [paper.pmcid, paper] as const),
  );
  const changed = drawn.papers
    .filter((paper) => {
      const was = before.get(paper.pmcid);
      return (
        was !== undefined &&
        (was.pickedFor !== paper.pickedFor || was.year !== paper.year)
      );
    })
    .map(({ pmcid }) => pmcid);
  const sheetMatches =
    JSON.stringify(drawn.sheetOrder) === JSON.stringify(recorded.sheetOrder);
  console.log(
    JSON.stringify({
      population: drawn.population,
      missing,
      extra,
      changed,
      sheetMatches,
    }),
  );
  if (
    missing.length > 0 ||
    extra.length > 0 ||
    changed.length > 0 ||
    !sheetMatches
  ) {
    process.exitCode = 1;
  }
}
