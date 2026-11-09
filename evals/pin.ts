import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest, snapshotKeys } from "./gold.ts";

// Pins a snapshot once a run has written it (docs/constraints/evals.md):
// the manifest's SHA-256 goes into evals/snapshot.json, and gold set A's
// paper ids and grant ids into evals/gold-a.json. Download the manifest
// into <dir>/eval/<id>/manifest.json first, then run
//
//   node evals/pin.ts <dir>
//
// and raise the change as a pull request. The manifest holds ids, hashes
// and grant ids only, so it is safe to read.

interface SnapshotFile {
  about: string;
  id: string;
  manifestSha256: string | null;
}

interface GoldAFile {
  about: string;
  query: string;
  seed: number;
  size: number;
  papers: { pmcid: string; grants: string[] }[];
}

const byPmcid = (a: { pmcid: string }, b: { pmcid: string }) =>
  Number(a.pmcid.slice(3)) - Number(b.pmcid.slice(3));

export function pin(
  raw: string,
  snapshot: SnapshotFile,
  goldA: GoldAFile,
): { snapshot: SnapshotFile; goldA: GoldAFile } {
  const parsed = manifest.parse(JSON.parse(raw));
  if (parsed.id !== snapshot.id) {
    throw new Error(`the manifest is for ${parsed.id}, not ${snapshot.id}`);
  }
  const drawn = parsed.goldA;
  if (
    drawn.query !== goldA.query ||
    drawn.seed !== goldA.seed ||
    drawn.size !== goldA.size
  ) {
    throw new Error("the manifest was drawn with another query, seed or size");
  }
  return {
    snapshot: {
      ...snapshot,
      manifestSha256: createHash("sha256").update(raw).digest("hex"),
    },
    goldA: {
      ...goldA,
      papers: parsed.papers
        .filter((paper) => paper.set === "A")
        .map((paper) => ({ pmcid: paper.pmcid, grants: paper.grants }))
        .sort(byPmcid),
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) throw new Error("usage: node evals/pin.ts <dir>");
  const here = (file: string) => new URL(file, import.meta.url);
  const read = (file: string): unknown =>
    JSON.parse(readFileSync(here(file), "utf8"));
  const snapshot = read("snapshot.json") as SnapshotFile;
  const result = pin(
    readFileSync(join(dir, snapshotKeys.manifest(snapshot.id)), "utf8"),
    snapshot,
    read("gold-a.json") as GoldAFile,
  );
  const write = (file: string, value: unknown) => {
    writeFileSync(here(file), `${JSON.stringify(value, null, 2)}\n`);
  };
  write("snapshot.json", result.snapshot);
  write("gold-a.json", result.goldA);
  console.log(
    `Pinned snapshot ${snapshot.id}: ${String(result.goldA.papers.length)} papers in gold set A.`,
  );
}
