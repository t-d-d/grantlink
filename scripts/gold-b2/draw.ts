import type { EuropePmc } from "../../src/europepmc/client.ts";
import { sample } from "../../src/pipeline/snapshot.ts";
import {
  everything,
  SHEET_COLUMNS as GOLD_B_COLUMNS,
  sheetCsv as goldBSheet,
} from "../gold-b/draw.ts";

// Draws gold set B2's 100 papers (#695, #699): a plain seeded draw from the
// papers the live search returns, less gold set B's. No check on a paper's
// text decides whether it joins, so the draw reads no text at all, only
// ids, and prints nothing from a paper (docs/constraints/personal-data.md).

// The live search, cut off the day before the draw: Europe PMC may still
// add papers published on the day itself. A draw on a later day then
// searches the same papers, less any Europe PMC has since linked or
// removed.
export function upTo(query: string, ranOn: string): string {
  const before = new Date(`${ranOn}T00:00:00Z`);
  before.setUTCDate(before.getUTCDate() - 1);
  const last = before.toISOString().slice(0, 10);
  return `(${query}) AND FIRST_PDATE:[1900-01-01 TO ${last}]`;
}

// The held-out papers: every paper found, once each, less the excluded
// ones, in the seed's order, and the first `size` of them.
export function heldOut(
  pmcids: readonly string[],
  exclude: readonly string[],
  seed: number,
  size: number,
): string[] {
  const left = new Set(exclude);
  const pool = [...new Set(pmcids)].filter((pmcid) => !left.has(pmcid));
  if (pool.length < size) {
    throw new Error(
      `only ${String(pool.length)} papers are left to draw ${String(size)} from`,
    );
  }
  return sample(pool, seed).slice(0, size);
}

export interface Plan {
  // The search, as a Europe PMC query. The client adds the open-access
  // terms itself, as for a run.
  query: string;
  seed: number;
  size: number;
  // Gold set B's papers.
  exclude: readonly string[];
}

export async function draw(
  api: EuropePmc,
  plan: Plan,
): Promise<{ papers: string[]; population: number }> {
  // everything() gives each paper once.
  const found = (await everything(api, plan.query)).map(({ pmcid }) => pmcid);
  return {
    papers: heldOut(found, plan.exclude, plan.seed, plan.size),
    population: found.length,
  };
}

// The columns docs/gold-set-b-guide.md names, which gold set B2's labels
// follow too.
export const SHEET_COLUMNS = [
  ...GOLD_B_COLUMNS,
  "passes",
  "flag",
  "look_in",
  "checked",
];

// The labelling sheet: a paper's id and its link, and empty columns for
// the labels. It holds no text from the paper.
export function sheetCsv(pmcids: readonly string[]): string {
  return goldBSheet(pmcids, SHEET_COLUMNS);
}
