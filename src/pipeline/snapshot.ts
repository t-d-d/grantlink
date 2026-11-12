import { createHash } from "node:crypto";
import { LARGEST_PAGE_SIZE } from "../europepmc/client.ts";
import { fundingSections } from "../europepmc/jats.ts";
import { GRANT, manifest, type Manifest } from "../../evals/gold.ts";
import { crukReference, printedGrants, sameGrant } from "../../evals/score.ts";
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
  return deps.text.hasSnapshot(deps.gold.snapshotId);
}

// One page of a drawn set's search, gold set A's or gold set A2's, which
// share a query (#695).
export async function searchGoldA(
  deps: Deps,
  cursor: string,
  query: string = deps.gold.goldA.query,
): Promise<{ pmcids: string[]; skipped: number; nextCursor: string | null }> {
  const page = await deps.europePmc.search(cursor, query, LARGEST_PAGE_SIZE);
  logger.info("snapshot-search", {
    hitCount: page.hitCount,
    found: page.papers.length,
    skipped: page.skipped,
  });
  return {
    pmcids: page.papers.map((paper) => paper.pmcid),
    skipped: page.skipped,
    nextCursor: page.nextCursor,
  };
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// Each grant once. Europe PMC often links one paper to the same grant in two
// forms, such as a C/A pair and its award number alone, and recall would
// count it twice (#508). Where two ids are the same grant by sameGrant, the
// fuller stays, at the place of the first: a C/A pair over its award number
// in any form, and otherwise the one with more letters and digits, so an
// award number with its A wins over one without. A slash Europe PMC doubled
// or left at the end does not count (#503).
const fullness = (grant: string): number =>
  (/C\d+[\\/∖]+A?\d/iu.test(grant) ? 1000 : 0) +
  grant.replace(/[^A-Za-z0-9]/gu, "").length;

export function oncePerGrant(grants: readonly string[]): string[] {
  const kept: string[] = [];
  for (const grant of grants) {
    const i = kept.findIndex((other) => sameGrant(other, grant));
    if (i === -1) kept.push(grant);
    else if (fullness(grant) > fullness(kept[i] ?? "")) kept[i] = grant;
  }
  return kept;
}

// `empty` says the funding-section cutter found no funding text or awards
// in a kept paper, which only a gold set B paper can be (#405).
export type Taken =
  { kept: true; entry: Entry; empty: boolean } | { kept: false };

// Reads one gold paper afresh into cache/, and writes its funding sections
// under the snapshot's own id once. A gold set A paper Europe PMC links to
// none of the funder's grants in a CRUK reference form, one whose full text
// prints none of them, or one with no funding text or awards, is passed
// over, and its sample walks on to the next. A kept gold set A paper's
// answers are the linked grants its whole article prints, less its
// reference list and the metadata in its front matter, not only its
// funding sections, so a cutter that dropped text cannot shrink the
// answers with it (#502, #503, #555), each grant once (#508). A funder
// registry id is never an answer. A gold set B paper is always kept, even
// with empty sections, since its label is scored against what the rules
// find in it, which may be nothing (#399). A gold set A paper's grants are
// read first, so a paper with none costs no full text. A grant id the
// manifest cannot hold, such as one with a space, is left out, or the
// manifest would refuse the whole snapshot. A gold set A2 paper is read as
// a gold set A paper is, and a gold set B2 paper as a gold set B paper is
// (#695).
export async function snapshotPaper(
  deps: Deps,
  pmcid: string,
  set: "A" | "A2" | "B" | "B2",
): Promise<Taken> {
  const drawn = set === "A" || set === "A2";
  const grants = drawn
    ? (await deps.europePmc.grants(pmcid)).filter(
        // crukReference refuses a Crossref Funder Registry id, such as
        // CRUK's own, which Europe PMC sometimes lists as a grant (#502).
        (grant) => GRANT.safeParse(grant).success && crukReference(grant),
      )
    : [];
  if (drawn && grants.length === 0) {
    logger.info("snapshot-passed-over", { pmcid });
    return { kept: false };
  }
  const article = await deps.europePmc.fullText(pmcid);
  const sections = fundingSections(article);
  await deps.text.putFundingText(pmcid, sections);
  const empty = sections.text.length === 0 && sections.awards.length === 0;
  const answers = drawn ? oncePerGrant(printedGrants(grants, article)) : [];
  if (drawn && (empty || answers.length === 0)) {
    logger.info("snapshot-passed-over", { pmcid });
    return { kept: false };
  }
  const stored = await deps.text.putSnapshotPaper(
    deps.gold.snapshotId,
    pmcid,
    JSON.stringify({ pmcid, ...sections }),
  );
  logger.info("snapshot-paper", { pmcid, grants: answers.length });
  return {
    kept: true,
    entry: { pmcid, set, sha256: sha256(stored), grants: answers },
    empty,
  };
}

// Writes the manifest once, and logs its hash, which the repo pins.
export async function writeManifest(
  deps: Deps,
  entries: Entry[],
): Promise<{ manifestSha256: string }> {
  const { goldA, goldA2, snapshotId } = deps.gold;
  const body = JSON.stringify(
    manifest.parse({
      id: snapshotId,
      createdAt: deps.now(),
      goldA: { query: goldA.query, seed: goldA.seed, size: goldA.size },
      goldA2: { query: goldA2.query, seed: goldA2.seed, size: goldA2.size },
      papers: entries,
    }),
  );
  const stored = await deps.text.putManifest(snapshotId, body);
  const manifestSha256 = sha256(stored);
  logger.info("snapshot-written", {
    id: snapshotId,
    papers: entries.length,
    manifestSha256,
  });
  return { manifestSha256 };
}
