import { z } from "zod";
import { pmcid as PMCID } from "../src/shared/pmcid.ts";
import goldAFile from "./gold-a.json" with { type: "json" };
import goldBFile from "./gold-b.json" with { type: "json" };
import snapshotFile from "./snapshot.json" with { type: "json" };

// The gold sets, the snapshot's pin, and the shape of the snapshot's files
// (docs/constraints/evals.md). The repo is public, so the gold sets hold
// paper ids, grant ids and labels only, never text.

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
// A grant id as Europe PMC holds it, or a label: the characters a reference
// is made of, and no space, so no sentence or name fits.
export const GRANT = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9/\\∖_.-]+$/u);

const sampling = z
  .object({
    query: z.string().min(1),
    seed: z.number().int(),
    size: z.number().int().positive(),
  })
  .strict();

export const goldA = sampling
  .extend({
    about: z.string(),
    papers: z.array(
      z.object({ pmcid: PMCID, grants: z.array(GRANT).min(1) }).strict(),
    ),
  })
  .strict()
  .parse(goldAFile);

export const goldB = z
  .object({
    about: z.string(),
    papers: z.array(
      z.object({ pmcid: PMCID, references: z.array(GRANT) }).strict(),
    ),
  })
  .strict()
  .parse(goldBFile);

export const pinned = z
  .object({
    about: z.string(),
    id: z.string().regex(/^s\d+$/u),
    manifestSha256: SHA256.nullable(),
  })
  .strict()
  .parse(snapshotFile);

// eval/<id>/manifest.json: each paper in the snapshot, which set it is in,
// the SHA-256 of its text file, and for gold set A Europe PMC's grant ids.
export const manifest = z
  .object({
    id: z.string().regex(/^s\d+$/u),
    createdAt: z.iso.datetime(),
    goldA: sampling,
    papers: z.array(
      z
        .object({
          pmcid: PMCID,
          set: z.enum(["A", "B"]),
          sha256: SHA256,
          grants: z.array(GRANT),
        })
        .strict(),
    ),
  })
  .strict();

export type Manifest = z.infer<typeof manifest>;

// eval/papers/<pmcid>.json: a paper's funding sections, as the run read
// them. It holds names, so it stays in the bucket and in the runner's
// working directory, and is never printed.
export const paperFile = z
  .object({
    pmcid: PMCID,
    text: z.array(z.string()),
    awards: z.array(
      z.union([
        z
          .object({ sources: z.array(z.string()), ids: z.array(z.string()) })
          .strict(),
        // A snapshot taken before #128 joins an award's sources with "; ".
        z
          .object({ source: z.string(), ids: z.array(z.string()) })
          .strict()
          .transform(({ source, ids }) => ({
            sources: source === "" ? [] : source.split("; "),
            ids,
          })),
      ]),
    ),
  })
  .strict();

export const snapshotKeys = {
  manifest: (id: string) => `eval/${id}/manifest.json`,
  paper: (pmcid: string) => `eval/papers/${pmcid}.json`,
};
