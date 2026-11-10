import type { goldA, goldB } from "../../evals/gold.ts";
import type { EuropePmc, SearchPaper } from "../europepmc/client.ts";
import { fundingSections } from "../europepmc/jats.ts";
import { findReferences, RULES_VERSION } from "../extract/rules.ts";
import { logger } from "../log.ts";
import { summarise } from "../page/found.ts";
import { deployRun, liveRelease, type Release } from "../page/release.ts";
import { buildPage } from "../page/render.ts";
import type { SiteBucket, TextBucket } from "../store/bucket.ts";
import type { Table } from "../store/table.ts";

// The work a run's steps do. Each takes what it needs and no durable
// context (docs/constraints/durable-execution.md), so a test can call it
// with fakes.

// The gold sets the eval snapshot reads, and the id it is taken under. The
// handler gives the repo's own, from evals/; a test gives small ones, so its
// time does not grow with gold set B.
export interface Gold {
  goldA: typeof goldA;
  goldB: typeof goldB;
  snapshotId: string;
}

export interface Deps {
  europePmc: EuropePmc;
  table: Table;
  text: TextBucket;
  site: SiteBucket;
  // The page's template, site/index.html as deployed with the function.
  template: () => Promise<string>;
  // The release the function was deployed as, site/release.json as
  // deployed with it, or null before the deploy records one.
  release: () => Promise<Release | null>;
  // The commit the function was deployed from.
  codeVersion: string;
  now: () => string;
  gold: Gold;
}

export interface SearchResult {
  // How many results the whole search holds, as Europe PMC counts them.
  hitCount: number;
  // This page's papers with full text.
  papers: SearchPaper[];
  // How many of this page's results carried a malformed PMCID.
  skipped: number;
  nextCursor: string | null;
}

// Reads one page of the search, and nothing else, so a step that retries
// it retries only Europe PMC.
export async function searchPage(
  deps: Deps,
  cursor: string,
): Promise<SearchResult> {
  const page = await deps.europePmc.search(cursor);
  logger.info("search-page", {
    hitCount: page.hitCount,
    found: page.papers.length,
    skipped: page.skipped,
  });
  return {
    hitCount: page.hitCount,
    papers: page.papers,
    skipped: page.skipped,
    nextCursor: page.nextCursor,
  };
}

// Logs the totals of the run's whole search once, before it is judged, so
// how many results it skipped for a malformed PMCID can be read without
// adding up its pages (#198).
export function logSearchEnded(
  runId: string,
  found: number,
  skipped: number,
): void {
  logger.info("search-ended", { runId, found, skipped });
}

// Logs the totals of gold set A's search once each time a run searches
// for the snapshot, before it is judged, as the run's search does (#279).
// When Europe PMC refuses a page, `refused` is true and the totals are
// those of the pages read before it, which are none when it refuses the
// first (#307).
export function logGoldSearchEnded(
  runId: string,
  snapshotId: string,
  found: number,
  skipped: number,
  refused: boolean,
): void {
  logger.info("snapshot-search-ended", {
    runId,
    snapshotId,
    found,
    skipped,
    refused,
  });
}

// Why a snapshot failed, as one of a fixed set of reasons. A log line
// carries ids and counts (docs/constraints/personal-data.md), so the line
// logs the reason, never the message the snapshot threw, which a store's or
// Europe PMC's client wrote (#285). The snapshot throws an error whose
// message is the reason; any other error is unknown.
export const SNAPSHOT_FAILURES = [
  "store-failed",
  "search-failed",
  "malformed-search",
] as const;
export type KnownSnapshotFailure = (typeof SNAPSHOT_FAILURES)[number];
export type SnapshotFailure = KnownSnapshotFailure | "unknown";

export function snapshotFailure(error: unknown): SnapshotFailure {
  if (!(error instanceof Error)) return "unknown";
  return (
    SNAPSHOT_FAILURES.find((reason) => reason === error.message) ?? "unknown"
  );
}

// Logs why the snapshot failed (#198).
export function logSnapshotFailed(
  runId: string,
  reason: SnapshotFailure,
): void {
  logger.warn("snapshot-failed", { runId, reason });
}

// A whole search that skipped results for a malformed PMCID and found no
// papers at all is taken as Europe PMC changing how it writes PMCIDs, not
// as a search that found nothing, and fails. A page is not judged alone:
// one bad record on a small page is skipped and counted, and the rest of
// the search goes on (#118). The run's search then fails the run, and gold
// set A's search fails the snapshot, which waits for the next run.
export function checkWholeSearch(found: number, skipped: number): void {
  if (skipped > 0 && found === 0) {
    throw new Error(
      `the search skipped ${String(skipped)} results for a malformed PMCID and found no papers`,
    );
  }
}

// Records each paper a page of the run's search found, and that this run's
// search returned it, and decides which still need reading. Safe to run
// twice: what the table holds of a paper is kept.
export async function recordPage(
  deps: Deps,
  papers: SearchPaper[],
  runId: string,
): Promise<string[]> {
  await deps.table.addFound(papers, deps.now(), runId);
  const ids = papers.map((paper) => paper.pmcid);
  const done = await deps.table.processed(ids);
  const todo = ids.filter((pmcid) => !done.has(pmcid));
  logger.info("page-recorded", { found: ids.length, todo: todo.length });
  return todo;
}

// Reads one paper: fetches its full text, keeps its funding sections in the
// bucket, and records the references the rules find. Nothing but the
// references reaches the table.
export async function readPaper(
  deps: Deps,
  pmcid: string,
  runId: string,
): Promise<{ references: number }> {
  const sections = fundingSections(await deps.europePmc.fullText(pmcid));
  await deps.text.putFundingText(pmcid, sections);
  const references = findReferences(sections);
  await deps.table.markProcessed(pmcid, {
    references,
    versions: { rules: RULES_VERSION, code: deps.codeVersion },
    processedAt: deps.now(),
    runId,
  });
  logger.info("paper-read", { pmcid, references: references.length });
  return { references: references.length };
}

// Records the run's search as the latest complete one, once it has ended,
// unless a run that started later has recorded its own. Safe to run twice.
export async function recordSearch(deps: Deps, runId: string): Promise<void> {
  await deps.table.recordSearch(runId);
  logger.info("search-recorded", { runId });
}

export async function markFailed(deps: Deps, pmcid: string): Promise<void> {
  await deps.table.markFailed(pmcid);
  logger.warn("paper-failed", { pmcid });
}

export type Published =
  | {
      published: true;
      papers: number;
      references: number;
      // "left" when another release's page was live, and kept.
      page: "written" | "left";
    }
  | { published: false; reason: string };

// Whether the live page belongs to another release than this run's own.
// The page a run builds shows its own release, and only the deploy writes
// release.json beside it, so a run writes the page only when the live
// record names its release (#119). One that started before a deploy would
// put the old template back (#73). One whose release is newer than the
// live record comes from a deploy whose publish failed, and leaves the
// page and its record to the next deploy. With no record on either side
// the page names no release, and a run writes it.
async function otherReleaseLive(
  deps: Deps,
  runId: string,
  own: Release | null,
): Promise<boolean> {
  const text = await deps.site.liveRelease();
  const live =
    text === null ? null : deployRun(liveRelease.parse(JSON.parse(text)));
  const ownRun = own === null ? null : deployRun(own);
  if (ownRun === live) return false;
  logger.info("page-left", {
    runId,
    ownDeploy: ownRun ?? "none",
    liveDeploy: live ?? "none",
  });
  return true;
}

// Builds the page from the table and publishes it. Only a run whose search
// finished gets here, and the page shows the papers the latest complete
// search returned, which may be another run's when two runs overlap
// (summarise in src/page/found.ts, #125). A table with no such paper read
// yet publishes nothing, so the page keeps what it had.
// The data always goes up. The page does only if the live release is the
// run's own, and otherwise the findings reach it at the next deploy or run.
// The site writes found.json before the page (siteBucket in
// src/store/bucket.ts), so a publish whose page write fails on every try
// leaves the new found.json on the site beside the old page. The README's
// "How a run works" says why that is acceptable.
export async function publish(deps: Deps, runId: string): Promise<Published> {
  // A run records its search before it publishes, so the record is there.
  // Before any is, the run's own search is the latest it knows of.
  const search = (await deps.table.latestSearch()) ?? runId;
  const found = summarise(
    await deps.table.all(),
    { runId, finishedAt: deps.now() },
    search,
  );
  if (found.counts.processed === 0) {
    logger.warn("publish-skipped", { runId, reason: "nothing-read" });
    return { published: false, reason: "nothing read" };
  }
  const data = JSON.stringify(found);
  const own = await deps.release();
  const left = await otherReleaseLive(deps, runId, own);
  await deps.site.publish(
    left
      ? { "found.json": data }
      : {
          "index.html": buildPage(await deps.template(), found, own),
          "found.json": data,
        },
  );
  const page = left ? "left" : "written";
  logger.info("published", {
    runId,
    papers: found.counts.papers,
    references: found.counts.references,
    page,
  });
  return {
    published: true,
    papers: found.counts.papers,
    references: found.counts.references,
    page,
  };
}
