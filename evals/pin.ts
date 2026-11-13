import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig, type Options } from "prettier";
import { manifest, snapshotKeys } from "./gold.ts";

// Pins a snapshot once a run has written it (docs/constraints/evals.md):
// the manifest's SHA-256 goes into evals/snapshot.json, gold set A's paper
// ids and grant ids into evals/gold-a.json, and gold set A2's into
// evals/gold-a2.json (#695). Download the manifest
// into <dir>/eval/<id>/manifest.json first, then run
//
//   node evals/pin.ts <dir>
//
// and raise the change as a pull request. The manifest holds ids, hashes
// and grant ids only, so it is safe to read.

interface SnapshotFile {
  about: string;
  id: string;
  cutter: string;
  manifestSha256: string | null;
}

// gold-a.json or gold-a2.json.
interface GoldAFile {
  about: string;
  query: string;
  seed: number;
  size: number;
  papers: { pmcid: string; grants: string[] }[];
}

const byPmcid = (a: { pmcid: string }, b: { pmcid: string }) =>
  Number(a.pmcid.slice(3)) - Number(b.pmcid.slice(3));

type Parsed = ReturnType<typeof manifest.parse>;

// A drawn set's file with its papers copied from the manifest, once its
// draw matches the file's query, seed and size.
function copied(parsed: Parsed, set: "A" | "A2", file: GoldAFile): GoldAFile {
  const drawn = set === "A" ? parsed.goldA : parsed.goldA2;
  if (drawn === undefined) {
    throw new Error(`the manifest has no draw for gold set ${set}`);
  }
  if (
    drawn.query !== file.query ||
    drawn.seed !== file.seed ||
    drawn.size !== file.size
  ) {
    throw new Error(
      `the manifest drew gold set ${set} with another query, seed or size`,
    );
  }
  return {
    ...file,
    papers: parsed.papers
      .filter((paper) => paper.set === set)
      .map((paper) => ({ pmcid: paper.pmcid, grants: paper.grants }))
      .sort(byPmcid),
  };
}

export function pin(
  raw: string,
  snapshot: SnapshotFile,
  goldA: GoldAFile,
  goldA2: GoldAFile,
): { snapshot: SnapshotFile; goldA: GoldAFile; goldA2: GoldAFile } {
  const parsed = manifest.parse(JSON.parse(raw));
  if (parsed.id !== snapshot.id) {
    throw new Error(`the manifest is for ${parsed.id}, not ${snapshot.id}`);
  }
  // A manifest taken before #443 records no cutter version.
  if (parsed.cutter !== undefined && parsed.cutter !== snapshot.cutter) {
    throw new Error(
      `the manifest was cut by ${parsed.cutter}, not ${snapshot.cutter}`,
    );
  }
  return {
    snapshot: {
      ...snapshot,
      manifestSha256: createHash("sha256").update(raw).digest("hex"),
    },
    goldA: copied(parsed, "A", goldA),
    goldA2: copied(parsed, "A2", goldA2),
  };
}

// Returns a file's text that the gate's format check accepts. The caller
// writes it. JSON.stringify puts each item of a short array on its own
// line, and Prettier would join them.
export function toFile(
  file: string,
  value: unknown,
  options: Options = {},
): Promise<string> {
  return format(JSON.stringify(value), { ...options, filepath: file });
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
    read("gold-a2.json") as GoldAFile,
  );
  // Formats every file before writing any, so a failure leaves none half
  // pinned. The editorconfig option matches what `prettier --check`
  // reads by default.
  const formatted = async (file: string, value: unknown) => {
    const path = fileURLToPath(here(file));
    const options = (await resolveConfig(path, { editorconfig: true })) ?? {};
    return { path, text: await toFile(path, value, options) };
  };
  const files = await Promise.all([
    formatted("snapshot.json", result.snapshot),
    formatted("gold-a.json", result.goldA),
    formatted("gold-a2.json", result.goldA2),
  ]);
  for (const { path, text } of files) writeFileSync(path, text);
  console.log(
    `Pinned snapshot ${snapshot.id}: ${String(result.goldA.papers.length)} papers in gold set A and ${String(result.goldA2.papers.length)} in gold set A2.`,
  );
}
