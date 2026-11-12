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
          // How many papers' replies could not be read. They are not
          // named.
          unprocessed: z.number().int().nonnegative(),
          // How many papers the model alone read. Its recall alone is over
          // these, and after the rules an unread paper scores the rules'
          // references (#696). A report filed before that has none, and
          // its recall alone counts an unread paper as missed.
          read: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type GoldA2Scores = z.infer<typeof goldA2Scores>;

// A held-out set's precision and recall, as gold set B's rows give them.
const heldOutBoth = z
  .object({ precision: heldOutRow, recall: heldOutRow })
  .strict();

// Gold set B2's precision and recall for the rules alone, and for each
// model alone and after the rules. It gates nothing and lists no misses
// (#695). A report filed before gold set B2 joined the eval has none, and
// still reads.
export const goldB2Scores = z
  .object({
    rules: heldOutBoth,
    models: z.array(
      z
        .object({
          modelId: z.string().min(1).max(100),
          alone: heldOutBoth,
          rulesThen: heldOutBoth,
          // How many papers' replies could not be read, not named.
          unprocessed: z.number().int().nonnegative(),
          // How many papers the model alone read. Its scores alone are over
          // these, and after the rules an unread paper scores the rules'
          // references (#696).
          read: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export type GoldB2Scores = z.infer<typeof goldB2Scores>;

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
            // How many papers of gold sets A and B the model read. Its rows
            // alone are over these and leave the rest out (#696). A report
            // filed before that has none, and its rows alone count an
            // unread paper as finding nothing.
            read: z
              .object({
                goldA: z.number().int().nonnegative(),
                goldB: z.number().int().nonnegative(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .optional(),
    missedA: z.array(PMCID),
    goldA2: goldA2Scores.optional(),
    goldB2: goldB2Scores.optional(),
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

// How many gold papers each model read alone, on each gold set it was
// sent papers of, as "read N of M" (#696). A report filed before the eval
// said so gives no line for that model.
export function readAlone(given: Report): string[] {
  const of = (rows: Report["rows"], id: RowId): number =>
    rows.find((row) => row.id === id)?.n ?? 0;
  return (given.candidates ?? []).flatMap((candidate) => {
    const a2 = given.goldA2?.models.find(
      (model) => model.modelId === candidate.modelId,
    );
    const b2 = given.goldB2?.models.find(
      (model) => model.modelId === candidate.modelId,
    );
    const sets = [
      ...(candidate.read === undefined
        ? []
        : [
            {
              on: "gold set A",
              read: candidate.read.goldA,
              of: of(given.baseline, "recall-a"),
            },
            {
              on: "gold set B",
              read: candidate.read.goldB,
              of: of(given.baseline, "recall-b"),
            },
          ]),
      ...(a2?.read === undefined || given.goldA2 === undefined
        ? []
        : [{ on: "gold set A2", read: a2.read, of: given.goldA2.rules.n }]),
      ...(b2 === undefined || given.goldB2 === undefined
        ? []
        : [
            {
              on: "gold set B2",
              read: b2.read,
              of: given.goldB2.rules.recall.n,
            },
          ]),
    ].filter((set) => set.of > 0);
    if (sets.length === 0) return [];
    const counts = sets.map(
      (set, i) =>
        `${String(set.read)} of ${String(set.of)}${i === 0 ? " papers" : ""} in ${set.on}`,
    );
    const list =
      counts.length === 1
        ? (counts[0] ?? "")
        : `${counts.slice(0, -1).join(", ")} and ${counts.at(-1) ?? ""}`;
    const leftOut = sets.some((set) => set.read < set.of)
      ? " Its scores alone leave out the papers it did not read."
      : "";
    return [`${candidate.modelId} alone read ${list}.${leftOut}`];
  });
}
