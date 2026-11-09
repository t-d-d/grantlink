import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { RULES_VERSION, type FundingSections } from "../src/extract/rules.ts";
import { FLOORS } from "./floors.ts";
import {
  goldA,
  goldB,
  manifest,
  paperFile,
  pinned,
  snapshotKeys,
} from "./gold.ts";
import { makeReport, verdict, type Report } from "./report.ts";
import { score, type GoldA, type GoldB, type Scores } from "./score.ts";

// The eval runner. It reads the snapshot from a directory laid out as the
// bucket is, and calls nothing outside the repo: the workflow downloads the
// snapshot and files the report in its own steps
// (docs/constraints/evals.md). Run
//
//   node evals/run.ts <snapshot-dir> [<report.json>]
//
// to print the scores, and with a second path to write a report. A report
// needs FINGERPRINT, COMMIT and RUN_URL, which only CI sets. It prints
// paper ids and scores, never text.

// Only the rules run until the model lands (#24).
export const MODEL_ID = "none: rules only";

const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

export function loadSnapshot(
  dir: string,
  pin: { id: string; manifestSha256: string | null },
): Map<string, FundingSections> {
  const texts = new Map<string, FundingSections>();
  if (pin.manifestSha256 === null) return texts;
  const raw = readFileSync(join(dir, snapshotKeys.manifest(pin.id)));
  if (sha256(raw) !== pin.manifestSha256) {
    throw new Error(
      `the manifest of snapshot ${pin.id} does not match its pin`,
    );
  }
  const { papers } = manifest.parse(JSON.parse(raw.toString("utf8")));
  for (const entry of papers) {
    const body = readFileSync(join(dir, snapshotKeys.paper(entry.pmcid)));
    if (sha256(body) !== entry.sha256) {
      throw new Error(`the text of ${entry.pmcid} does not match the manifest`);
    }
    const { pmcid, ...sections } = paperFile.parse(
      JSON.parse(body.toString("utf8")),
    );
    if (pmcid !== entry.pmcid) {
      throw new Error(`the file for ${entry.pmcid} holds another paper`);
    }
    texts.set(pmcid, sections);
  }
  return texts;
}

type Rows = Report["rows"];

const asRows = (scores: Scores): Rows =>
  FLOORS.map((floor) => ({ id: floor.id, ...scores.rows[floor.id] }));

export function evaluate(input: {
  texts: ReadonlyMap<string, FundingSections>;
  goldA: readonly GoldA[];
  goldB: readonly GoldB[];
}): { rows: Rows; baseline: Rows; missedA: string[] } {
  // The release is the rules alone until the model lands, so the baseline
  // is the same run.
  const release = score(input);
  return {
    rows: asRows(release),
    baseline: asRows(release),
    missedA: release.missedA,
  };
}

// The gold papers to score. A snapshot not yet pinned scores nothing: a
// pull request that adds labels names a new snapshot with no pin, its rows
// wait rather than block, and once it deploys a run takes the snapshot and
// a later pull request pins it. Unpinning shows in review, in
// evals/snapshot.json.
export function goldToScore(
  pin: { manifestSha256: string | null },
  a: readonly GoldA[],
  b: readonly GoldB[],
): { goldA: readonly GoldA[]; goldB: readonly GoldB[] } {
  return pin.manifestSha256 === null
    ? { goldA: [], goldB: [] }
    : { goldA: a, goldB: b };
}

const ciEnv = z.object({
  FINGERPRINT: z.string().min(1),
  COMMIT: z.string().min(1),
  RUN_URL: z.string().min(1),
});

function main(dir: string, out: string | undefined): void {
  const texts = loadSnapshot(dir, pinned);
  const result = evaluate({
    texts,
    ...goldToScore(pinned, goldA.papers, goldB.papers),
  });
  const meta = out === undefined ? undefined : ciEnv.parse(process.env);
  const report = makeReport({
    fingerprint: meta?.FINGERPRINT ?? "0".repeat(64),
    commit: meta?.COMMIT ?? "0".repeat(40),
    runUrl:
      meta?.RUN_URL ?? "https://github.com/t-d-d/grantlink/actions/runs/0",
    modelId: MODEL_ID,
    rulesVersion: RULES_VERSION,
    snapshot:
      pinned.manifestSha256 === null
        ? null
        : { id: pinned.id, manifestSha256: pinned.manifestSha256 },
    createdAt: new Date().toISOString(),
    ...result,
  });
  for (const row of verdict(report).rows) {
    const shown = row.score === null ? "-" : row.score.toFixed(4);
    console.log(`${row.id}\t${shown}\tn=${String(row.n)}\t${row.result}`);
  }
  if (result.missedA.length > 0) {
    console.log(`missed in gold set A: ${result.missedA.join(" ")}`);
  }
  if (out !== undefined) writeFileSync(out, `${JSON.stringify(report)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (dir === undefined) {
    throw new Error("usage: node evals/run.ts <snapshot-dir> [<report.json>]");
  }
  main(dir, out);
}
