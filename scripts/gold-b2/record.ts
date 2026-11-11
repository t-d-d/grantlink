import { z } from "zod";
import { pmcid as PMCID } from "../../src/shared/pmcid.ts";

// Gold set B2's recorded draw: the search it ran, the day, how many papers
// that search found, the seed, the size and the papers drawn, ids only.
export const RECORD = "docs/gold-set-b2-sample.json";
export const SHEET = "docs/gold-set-b2-sheet.csv";

export const record = z
  .object({
    about: z.string(),
    query: z.string().min(1),
    ranOn: z.iso.date(),
    population: z.number().int().nonnegative(),
    seed: z.number().int(),
    size: z.number().int().positive(),
    papers: z.array(PMCID),
  })
  .strict();
