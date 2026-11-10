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
    candidates: z
      .array(
        z
          .object({
            modelId: z.string().min(1).max(100),
            rows,
            unprocessed: z.array(PMCID),
          })
          .strict(),
      )
      .optional(),
    missedA: z.array(PMCID),
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
