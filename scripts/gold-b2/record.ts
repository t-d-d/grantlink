import { z } from "zod";
import { pmcid as PMCID } from "../../src/shared/pmcid.ts";

// Gold set B2's recorded draw: the search it ran, the day, how many papers
// that search found, the seed, the size and the papers drawn, ids only.
export const RECORD = "docs/gold-set-b2-sample.json";
export const SHEET = "docs/gold-set-b2-sheet.csv";
// The proposals as the passes made them, which the owner leaves alone, so
// #701 can count what the check changed.
export const PROPOSED = "docs/gold-set-b2-proposed.csv";
// Each pass's own labels, two rows a paper.
export const PASSES = "docs/gold-set-b2-passes.csv";
export const PASSES_COLUMNS = [
  "pmcid",
  "pass",
  "funded",
  "references_as_written",
  "references_normalised",
  "unsure",
];

// How the labels were proposed (#700): the model that made the two passes,
// the versions of the rules and the prompt that read the funding sections,
// each model that read them alone, and the seed and size of the random
// check of the rows nothing flagged.
const labels = z
  .object({
    labeller: z.string().min(1),
    labelledOn: z.iso.date(),
    rules: z.string().regex(/^rules-\d+$/u),
    prompt: z.string().regex(/^prompt-\d+$/u),
    models: z.array(z.string().min(1)).min(1),
    checkSeed: z.number().int(),
    checkSize: z.number().int().positive(),
  })
  .strict();

export const record = z
  .object({
    about: z.string(),
    query: z.string().min(1),
    ranOn: z.iso.date(),
    population: z.number().int().nonnegative(),
    seed: z.number().int(),
    size: z.number().int().positive(),
    papers: z.array(PMCID),
    labels: labels.optional(),
  })
  .strict();
