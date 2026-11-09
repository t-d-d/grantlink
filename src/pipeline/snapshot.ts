import { createHash } from "node:crypto";
import { fundingSections } from "../europepmc/jats.ts";
import {
  GRANT,
  goldA,
  manifest,
  pinned,
  type Manifest,
} from "../../evals/gold.ts";
import { logger } from "../log.ts";
import type { Deps } from "./steps.ts";

// The work of taking the eval snapshot (docs/constraints/evals.md): gold
// set A sampled once with its recorded query and seed, each gold paper's
// funding text written under eval/ once, and a manifest of each paper and
// its text's hash. The repo pins the manifest's hash afterwards. Nothing
// here takes a durable context; src/run/snapshot.ts calls these in steps.

export type Entry = Manifest["papers"][number];

// A seeded generator (mulberry32), so the same seed gives the same sample.
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The order gold set A is drawn in: every paper the query found, once each,
// sorted by id and then shuffled with the seed. The snapshot walks this
// order and keeps the first papers it can read, up to the set's size.
export function sample(pmcids: readonly string[], seed: number): string[] {
  const order = [...new Set(pmcids)].sort(
    (a, b) => Number(a.slice(3)) - Number(b.slice(3)),
  );
  const random = generator(seed);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j] ?? "", order[i] ?? ""];
  }
  return order;
}

export async function snapshotTaken(deps: Deps): Promise<boolean> {
  return deps.text.hasSnapshot(pinned.id);
}

export async function searchGoldA(
  deps: Deps,
  cursor: string,
): Promise<{ pmcids: string[]; nextCursor: string | null }> {
  const page = await deps.europePmc.search(cursor, goldA.query);
  logger.info("snapshot-search", {
    hitCount: page.hitCount,
    found: page.papers.length,
    skipped: page.skipped,
  });
  return {
    pmcids: page.papers.map((paper) => paper.pmcid),
    nextCursor: page.nextCursor,
  };
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export type Taken = { kept: true; entry: Entry } | { kept: false };

// Reads one gold paper afresh into cache/, and writes its funding sections
// under eval/ once. A gold set A paper Europe PMC links to none of the
// funder's grants, or one with no funding text, is passed over. Its grants
// are read first, so a paper with none costs no full text. A grant id the
// manifest cannot hold, such as one with a space, is left out, or the
// manifest would refuse the whole snapshot.
export async function snapshotPaper(
  deps: Deps,
  pmcid: string,
  set: "A" | "B",
): Promise<Taken> {
  const grants =
    set === "A"
      ? (await deps.europePmc.grants(pmcid)).filter(
          (grant) => GRANT.safeParse(grant).success,
        )
      : [];
  if (set === "A" && grants.length === 0) {
    logger.info("snapshot-passed-over", { pmcid });
    return { kept: false };
  }
  const sections = fundingSections(await deps.europePmc.fullText(pmcid));
  await deps.text.putFundingText(pmcid, sections);
  if (sections.text.length === 0 && sections.awards.length === 0) {
    logger.info("snapshot-passed-over", { pmcid });
    return { kept: false };
  }
  const stored = await deps.text.putSnapshotPaper(
    pmcid,
    JSON.stringify({ pmcid, ...sections }),
  );
  logger.info("snapshot-paper", { pmcid, grants: grants.length });
  return {
    kept: true,
    entry: { pmcid, set, sha256: sha256(stored), grants },
  };
}

// Writes the manifest once, and logs its hash, which the repo pins.
export async function writeManifest(
  deps: Deps,
  entries: Entry[],
): Promise<{ manifestSha256: string }> {
  const body = JSON.stringify(
    manifest.parse({
      id: pinned.id,
      createdAt: deps.now(),
      goldA: { query: goldA.query, seed: goldA.seed, size: goldA.size },
      papers: entries,
    }),
  );
  const stored = await deps.text.putManifest(pinned.id, body);
  const manifestSha256 = sha256(stored);
  logger.info("snapshot-written", {
    id: pinned.id,
    papers: entries.length,
    manifestSha256,
  });
  return { manifestSha256 };
}
