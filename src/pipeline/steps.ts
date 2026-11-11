import type { goldA, goldB } from "../../evals/gold.ts";
import type { EuropePmc, SearchPaper } from "../europepmc/client.ts";
import { fundingSections } from "../europepmc/jats.ts";
import { failureReason, type PaperFailure } from "./failure.ts";
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
// adding up its pages (#198). When Europe PMC refuses a page, `refused` is
// true, and when a page fails after its retries without a refusal,
// `failed` is true. The totals are then those of the pages read before it
// (#348).
export function logSearchEnded(
  runId: string,
  found: number,
  skipped: number,
  refused: boolean,
  failed: boolean,
): void {
  logger.info("search-ended", { runId, found, skipped, refused, failed });
}

// Logs the totals of gold set A's search once each time a run searches
// for the snapshot, before it is judged, as the run's search does (#279).
// When Europe PMC refuses a page, `refused` is true and the totals are
// those of the pages read before it, which are none when it refuses the
// first (#307). When a page fails after its retries without a refusal,
// `failed` is true, and the totals are again those of the pages before it
// (#348).
export function logGoldSearchEnded(
  runId: string,
  snapshotId: string,
  found: number,
  skipped: number,
  refused: boolean,
  failed: boolean,
): void {
  logger.info("snapshot-search-ended", {
    runId,
    snapshotId,
    found,
    skipped,
    refused,
    failed,
  });
}

// How many gold set B papers the snapshot kept with no funding text or
// awards although their label lists references, and which. The snapshot
// keeps them, so the eval scores each as a miss, but empty sections for
// such a paper more likely mean the cutter misread its full text (#405).
// The line carries ids and a count only (docs/constraints/personal-data.md).
export function logGoldBEmpty(
  runId: string,
  snapshotId: string,
  pmcids: readonly string[],
): void {
  logger.info("snapshot-b-empty", {
    runId,
    snapshotId,
    count: pmcids.length,
    pmcids: pmcids.join(","),
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

// Why a snapshot that returned, rather than threw, was not taken: Europe
// PMC refused gold set A's search, or a gold set B paper failed (#399).
export type SnapshotLost = "search-refused" | "gold-paper-failed";

// Logs why the snapshot failed (#198), and where one paper caused it, that
// paper's PMCID and set (#399).
export function logSnapshotFailed(
  runId: string,
  reason: SnapshotFailure | SnapshotLost,
  paper?: { pmcid: string; set: "A" | "B" },
): void {
  logger.warn("snapshot-failed", { runId, reason, ...paper });
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

// The number of a rules version, `rules-<number>`, or null for a version
// this code cannot read the number of.
function rulesNumber(version: string): number | null {
  const match = /^rules-(\d+)$/u.exec(version);
  return match?.[1] === undefined ? null : Number(match[1]);
}

// Whether the rules version that read a paper, or null for none recorded,
// is older than `current`. Versions compare by number, not as strings, and
// a version whose number cannot be read counts as not older, so the row
// stays as it is (#686).
export function olderRules(read: string | null, current: string): boolean {
  if (read === null) return true;
  const was = rulesNumber(read);
  const now = rulesNumber(current);
  return was !== null && now !== null && was < now;
}

// A paper an older rules version read, and that version, or null for none
// recorded.
export interface ToRerun {
  pmcid: string;
  from: string | null;
}

// The papers a page leaves to read, those of them whose full text answered
// 500 when they last failed, which the run asks for once (#504), and the
// papers an older rules version read, which the run re-runs the rules on
// from cache/ (#686).
export interface ToRead {
  todo: string[];
  once: string[];
  rerun: ToRerun[];
}

// Records each paper a page of the run's search found, and that this run's
// search returned it, and decides which still need reading and which of
// those to ask for once. Safe to run twice: what the table holds of a paper
// is kept.
export async function recordPage(
  deps: Deps,
  papers: SearchPaper[],
  runId: string,
): Promise<ToRead> {
  await deps.table.addFound(papers, deps.now(), runId);
  const ids = papers.map((paper) => paper.pmcid);
  const done = await deps.table.rulesRead(ids);
  const todo = ids.filter((pmcid) => !done.has(pmcid));
  const failed = await deps.table.lastFailures(todo);
  const once = todo.filter((pmcid) => failed.get(pmcid) === 500);
  const rerun = [...done]
    .filter(([, from]) => olderRules(from, RULES_VERSION))
    .map(([pmcid, from]) => ({ pmcid, from }));
  logger.info("page-recorded", {
    found: ids.length,
    todo: todo.length,
    once: once.length,
    rerun: rerun.length,
  });
  return { todo, once, rerun };
}

// Reads one paper: fetches its full text, keeps its funding sections in the
// bucket, and records the references the rules find. Nothing but the
// references reaches the table. With `once`, Europe PMC's client sends one
// request for the full text and does not try again (#504).
export async function readPaper(
  deps: Deps,
  pmcid: string,
  runId: string,
  once = false,
): Promise<{ references: number }> {
  const sections = fundingSections(
    await deps.europePmc.fullText(pmcid, { once }),
  );
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

// What re-running the rules on a paper did: replaced its references,
// found no text for it in cache/, or found another rules version had read it
// since, whose result stays.
export type Reread =
  { reread: { references: number } } | { noText: true } | { left: true };

// Re-runs the current rules on a paper an older rules version read, from its
// funding sections in cache/, and asks Europe PMC nothing (#686,
// docs/constraints/europe-pmc.md). A paper with no text there stays as it
// is. Safe to run twice.
export async function rereadPaper(
  deps: Deps,
  { pmcid, from }: ToRerun,
  runId: string,
): Promise<Reread> {
  const sections = await deps.text.getFundingText(pmcid);
  if (sections === null) {
    logger.warn("paper-reread-no-text", { pmcid });
    return { noText: true };
  }
  const references = findReferences(sections);
  const written = await deps.table.replaceReferences(pmcid, from, {
    references,
    versions: { rules: RULES_VERSION, code: deps.codeVersion },
    processedAt: deps.now(),
    runId,
  });
  if (!written) {
    logger.info("paper-reread-left", { pmcid });
    return { left: true };
  }
  logger.info("paper-reread", {
    pmcid,
    from: from ?? "none",
    references: references.length,
  });
  return { reread: { references: references.length } };
}

// Logs a paper whose re-run failed after its retries. Its row stays as it
// was, for the next run (#686).
export function logRerunFailed(pmcid: string): void {
  logger.warn("paper-reread-failed", { pmcid });
}

// Records the run's search as the latest complete one, once it has ended,
// unless a run that started later has recorded its own. Safe to run twice.
export async function recordSearch(deps: Deps, runId: string): Promise<void> {
  await deps.table.recordSearch(runId);
  logger.info("search-recorded", { runId });
}

// Marks a paper failed, and logs why and how hard the run tried (#378).
export async function markFailed(
  deps: Deps,
  pmcid: string,
  failure: PaperFailure,
): Promise<void> {
  await deps.table.markFailed(pmcid, failureReason(failure));
  logger.warn("paper-failed", { pmcid, ...failure });
}

// Logs a gold paper the snapshot could not read, and its set, as a run
// logs a paper that fails (#378).
export function logGoldPaperFailed(
  pmcid: string,
  set: "A" | "B",
  failure: PaperFailure,
): void {
  logger.warn("gold-paper-failed", { pmcid, set, ...failure });
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
