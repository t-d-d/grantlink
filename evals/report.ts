import { z } from "zod";
import { pmcid as PMCID } from "../src/shared/pmcid.ts";
import {
  FLOORS,
  judge,
  type Floor,
  type Result,
  type RowId,
} from "./floors.ts";

// An eval report: the scores for one fingerprint, and what produced them
// (docs/constraints/evals.md). CI files one under eval-reports/ in the
// private bucket for each fingerprint, written once. It holds scores and
// paper ids, never text, so it may be printed and published.

// The model id a report names when the release calls no model. Rules ship
// alone: neither model the eval scores adds the 10 points of recall on gold
// set B that the go/no-go asks for (#330).
export const RULES_ALONE = "none: rules only";

const ids = FLOORS.map((floor) => floor.id);
export const HEX = (length: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${String(length)}}$`, "u"));

const row = z
  .object({
    id: z.enum(ids as [RowId, ...RowId[]]),
    score: z.number().nonnegative().nullable(),
    n: z.number().int().nonnegative(),
  })
  .strict();

// Every row in the go/no-go table, once each and in its order.
const rows = z
  .array(row)
  .refine(
    (list) =>
      list.length === ids.length && list.every((r, i) => r.id === ids[i]),
    { message: "a report has every go/no-go row, in order" },
  );

// A held-out set's recall over its papers, with no ids beside it (#695).
const heldOutRow = z
  .object({
    score: z.number().nonnegative().nullable(),
    n: z.number().int().nonnegative(),
  })
  .strict();

// Gold set A2's recall for the rules alone, and for each model alone and
// after the rules. It gates nothing and lists no misses (#695). A report
// filed before gold set A2 joined the eval has none, and still reads.
export const goldA2Scores = z
  .object({
    rules: heldOutRow,
    models: z.array(
      z
        .object({
          modelId: z.string().min(1).max(100),
          alone: heldOutRow,
          rulesThen: heldOutRow,
          // How many papers' replies could not be read. They count as
          // missed, and are not named.
          unprocessed: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export type GoldA2Scores = z.infer<typeof goldA2Scores>;

export const report = z
  .object({
    fingerprint: HEX(64),
    commit: HEX(40),
    // The GitHub Actions run that produced the report.
    runUrl: z
      .url({ protocol: /^https$/u })
      .regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+/u),
    modelId: z.string().min(1).max(100),
    rulesVersion: z.string().min(1).max(40),
    // The snapshot the scores came from, or null before there is one.
    snapshot: z
      .object({ id: z.string().min(1).max(20), manifestSha256: HEX(64) })
      .strict()
      .nullable(),
    createdAt: z.iso.datetime(),
    rows,
    // The same rows for the rules alone, with no model.
    baseline: rows,
    // The same rows for the rules and then each model the eval compares,
    // with the papers each model's reply could not be read for (#329). A
    // report filed before the eval scored a model has none, and still reads.
    // alone holds the same rows for the model with no rules (#694), and a
    // report filed before that has none.
    candidates: z
      .array(
        z
          .object({
            modelId: z.string().min(1).max(100),
            rows,
            alone: rows.optional(),
            unprocessed: z.array(PMCID),
          })
          .strict(),
      )
      .optional(),
    missedA: z.array(PMCID),
    goldA2: goldA2Scores.optional(),
  })
  .strict();

export type Report = z.infer<typeof report>;

export const makeReport = (fields: Report): Report => report.parse(fields);

export interface Judged extends Floor {
  score: number | null;
  baseline: number | null;
  n: number;
  result: Result;
}

export interface Verdict {
  // Every gating row clears its floor, or has no data yet.
  releasable: boolean;
  rows: Judged[];
}

export function verdict(given: Report): Verdict {
  const parsed = report.parse(given);
  const judged = FLOORS.map((floor, i): Judged => {
    const own = parsed.rows[i];
    const base = parsed.baseline[i];
    const score = own?.score ?? null;
    return {
      ...floor,
      score,
      baseline: base?.score ?? null,
      n: own?.n ?? 0,
      result: judge(floor.id, score),
    };
  });
  return {
    releasable: judged.every(
      (row) => row.gates !== "yes" || row.result !== "no-go",
    ),
    rows: judged,
  };
}
