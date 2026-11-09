import type { EuropePmc, SearchPaper } from "../europepmc/client.ts";
import { fundingSections } from "../europepmc/jats.ts";
import { findReferences, RULES_VERSION } from "../extract/rules.ts";
import { logger } from "../log.ts";
import { summarise } from "../page/found.ts";
import type { Release } from "../page/release.ts";
import { buildPage } from "../page/render.ts";
import type { SiteBucket, TextBucket } from "../store/bucket.ts";
import type { Table } from "../store/table.ts";

// The work a run's steps do. Each takes what it needs and no durable
// context (docs/constraints/durable-execution.md), so a test can call it
// with fakes.

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
}

export interface SearchResult {
  // How many results the whole search holds, as Europe PMC counts them.
  hitCount: number;
  // This page's papers with full text.
  papers: SearchPaper[];
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
    nextCursor: page.nextCursor,
  };
}

// Records each paper a page of the search found, and decides which still
// need reading. Safe to run twice: a paper already held is left as it is.
export async function recordPage(
  deps: Deps,
  papers: SearchPaper[],
): Promise<string[]> {
  await deps.table.addFound(papers, deps.now());
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

export async function markFailed(deps: Deps, pmcid: string): Promise<void> {
  await deps.table.markFailed(pmcid);
  logger.warn("paper-failed", { pmcid });
}

export type Published =
  | { published: true; papers: number; references: number }
  | { published: false; reason: string };

// Builds the page from every row in the table and publishes it. A table
// with no paper read yet publishes nothing, so the page keeps what it had.
export async function publish(deps: Deps, runId: string): Promise<Published> {
  const found = summarise(await deps.table.all(), {
    runId,
    finishedAt: deps.now(),
  });
  if (found.counts.processed === 0) {
    logger.warn("publish-skipped", { runId, reason: "nothing-read" });
    return { published: false, reason: "nothing read" };
  }
  await deps.site.publish({
    "index.html": buildPage(await deps.template(), found, await deps.release()),
    "found.json": JSON.stringify(found),
  });
  logger.info("published", {
    runId,
    papers: found.counts.papers,
    references: found.counts.references,
  });
  return {
    published: true,
    papers: found.counts.papers,
    references: found.counts.references,
  };
}
