import { readFileSync, writeFileSync } from "node:fs";
import {
  europePmc,
  searchQuery,
  type EuropePmc,
} from "../../src/europepmc/client.ts";
import { goldB } from "../../evals/gold.ts";
import { draw, sheetCsv, upTo } from "./draw.ts";
import { record, RECORD, SHEET } from "./record.ts";

// Draws gold set B2's sample from Europe PMC and checks it against the
// papers recorded in docs/gold-set-b2-sample.json (#699). It reads Europe
// PMC through the service's own client, at its pace, and prints ids and
// counts only.
//
//   node scripts/gold-b2/sample.ts           draw again with the recorded
//                                           search and seed, and compare
//   node scripts/gold-b2/sample.ts --write   draw from today's live search,
//                                           and record the draw and the sheet

const ABOUT =
  "Gold set B2's sample (#695, #699): ids only, never text. scripts/gold-b2/sample.ts draws it from Europe PMC: every open-access paper the live search (searchQuery() in src/europepmc/client.ts) found, published up to the day before it ran, less gold set B's papers (evals/gold-b.json), shuffled with the seed, and the first `size` of them. No check on a paper's text decides whether it joins. population counts the papers the search found, gold set B's among them. Run the script without --write to draw again and compare. The sheet lists the same papers in the same order.";
const SEED = 20261111;
const SIZE = 100;

const today = new Date().toISOString().slice(0, 10);
// A new draw would blank the sheet and drop the labels' record, so once the
// passes have proposed labels (#700) the sample is not drawn again here.
if (
  process.argv.includes("--write") &&
  record.parse(JSON.parse(readFileSync(RECORD, "utf8"))).labels !== undefined
) {
  throw new Error(
    "gold set B2 is labelled: drawing again would discard its labels",
  );
}
const recorded = process.argv.includes("--write")
  ? undefined
  : record.parse(JSON.parse(readFileSync(RECORD, "utf8")));
const plan = recorded ?? {
  query: upTo(searchQuery(), today),
  seed: SEED,
  size: SIZE,
};

const client = europePmc();
// Europe PMC can take many seconds a request, so the draw says where it is.
const api: EuropePmc = {
  ...client,
  search: (cursor, selection, pageSize) => {
    console.error(`search page ${cursor.slice(0, 12)}`);
    return client.search(cursor, selection, pageSize);
  },
};
const drawn = await draw(api, {
  ...plan,
  exclude: goldB.papers.map(({ pmcid }) => pmcid),
});

if (recorded === undefined) {
  const next = record.parse({
    about: ABOUT,
    query: plan.query,
    ranOn: today,
    population: drawn.population,
    seed: plan.seed,
    size: plan.size,
    papers: drawn.papers,
  });
  writeFileSync(RECORD, `${JSON.stringify(next, null, 2)}\n`);
  writeFileSync(SHEET, sheetCsv(drawn.papers));
  console.log(
    JSON.stringify({
      population: drawn.population,
      drawn: drawn.papers.length,
    }),
  );
} else {
  const want = recorded.papers;
  const missing = want.filter((pmcid) => !drawn.papers.includes(pmcid));
  const extra = drawn.papers.filter((pmcid) => !want.includes(pmcid));
  const orderMatches = JSON.stringify(drawn.papers) === JSON.stringify(want);
  console.log(
    JSON.stringify({
      population: drawn.population,
      recordedPopulation: recorded.population,
      missing,
      extra,
      orderMatches,
    }),
  );
  if (missing.length > 0 || extra.length > 0 || !orderMatches) {
    process.exitCode = 1;
  }
}
