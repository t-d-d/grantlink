import {
  DurableOperationError,
  type DurableContext,
} from "@aws/durable-execution-sdk-js";
import {
  checkWholeSearch,
  logSearchEnded,
  logRerunFailed,
  logSnapshotFailed,
  snapshotFailure,
  markFailed,
  publish,
  readPaper,
  recordPage,
  rereadPaper,
  recordSearch,
  searchPage,
  type Deps,
  type Published,
  type ToRerun,
} from "../pipeline/steps.ts";
import { batches } from "../shared/batches.ts";
import { logOnly } from "./log-only.ts";
import {
  askEuropePmc,
  askForPaper,
  type Asked,
  type Owed,
  type PaperAsked,
} from "./owed.ts";
import { europePmcRetry, onceRetry, paperRetry, storeRetry } from "./retry.ts";
import { takeSnapshot, type SnapshotSummary } from "./snapshot.ts";

// A run: search Europe PMC page by page, record what each page found, read
// each paper not yet read, then publish the page. Every I/O call sits in a
// step (docs/constraints/durable-execution.md). A paper that fails is left for
// the next run. A run whose search finds nothing publishes nothing. A run
// that fails publishes nothing, with one exception: a run that fails while it
// publishes can leave its found.json on the site, because each try writes
// found.json before the page (siteBucket.publish in src/store/bucket.ts, and
// the README). Otherwise a run publishes if any paper the latest complete
// search returned has been read, by this run or an earlier one (publish in
// src/pipeline/steps.ts). Runs may overlap: the latest complete search is the
// one that started latest, whichever run finishes last (#125).

// Papers per child context. Each batch ends with a short wait, so each
// Lambda invocation does a bounded amount of work, and a replay skips each
// finished batch whole.
export const BATCH = 50;

export interface RunSummary {
  runId: string;
  found: number;
  // Results the search skipped for a malformed PMCID.
  skipped: number;
  read: number;
  failed: number;
  // Papers an older rules version read whose references the current rules
  // replaced, from the text in cache/ (#686).
  reread: number;
  published: Published;
  snapshot: SnapshotSummary;
}

interface BatchOutcome {
  read: number;
  failed: number;
  owed: Owed;
}

// Reads a batch of papers, first waiting out any wait an earlier refusal
// left `owed`. A paper in `once` gets one request, with no retry (#504). It
// returns the wait its own last refusal leaves owed, if no paper after it
// has paid it.
async function readBatch(
  ctx: DurableContext,
  deps: Deps,
  pmcids: string[],
  once: string[],
  runId: string,
  owed: Owed,
): Promise<BatchOutcome> {
  let read = 0;
  let failed = 0;
  let due = owed;
  for (const pmcid of pmcids) {
    if (due !== null) await ctx.wait(due.name, { seconds: due.seconds });
    due = null;
    let asked: PaperAsked<{ references: number }>;
    const single = once.includes(pmcid);
    try {
      asked = await askForPaper(
        ctx,
        `paper-${pmcid}`,
        `wait-${pmcid}`,
        single ? onceRetry : paperRetry,
        () => deps.europePmc.sent(),
        async () => readPaper(deps, pmcid, runId, single),
      );
    } catch (error) {
      // The step returns a paper's own failure, so what reaches here is the
      // step failing around it, as when its result cannot be checkpointed,
      // and how many requests or tries it took is unknown. An error the SDK
      // raises for itself is thrown as it is, as the search does.
      if (!(error instanceof DurableOperationError)) throw error;
      asked = { failed: { why: "code" }, owed: null };
    }
    if ("read" in asked) {
      read += 1;
      continue;
    }
    failed += 1;
    const { failed: failure, owed: left } = asked;
    try {
      await ctx.step(
        `failed-${pmcid}`,
        async () => markFailed(deps, pmcid, failure),
        { retryStrategy: storeRetry },
      );
    } catch (error) {
      // A mark that fails after its retries ends the run, so the run waits
      // out the wait this paper's refusal left before it throws, and a run
      // started after it never asks Europe PMC too soon (#412). An error the
      // SDK raises for itself is thrown as it is.
      if (!(error instanceof DurableOperationError) || left === null) {
        throw error;
      }
      await ctx.wait(left.name, { seconds: left.seconds });
      throw error;
    }
    // Europe PMC asked the run to wait before it asks again, so whatever
    // asks it next waits first (docs/constraints/europe-pmc.md).
    due = left;
  }
  return { read, failed, owed: due };
}

// Re-runs the current rules on a batch of papers an older rules version
// read, from their text in cache/, with no request to Europe PMC (#686).
// A paper whose step fails after its retries keeps its row for the next
// run, and the batch carries on. Returns how many it re-read.
async function rerunBatch(
  ctx: DurableContext,
  deps: Deps,
  papers: ToRerun[],
  runId: string,
): Promise<number> {
  let reread = 0;
  for (const paper of papers) {
    try {
      const done = await ctx.step(
        `rerun-${paper.pmcid}`,
        async () => rereadPaper(deps, paper, runId),
        { retryStrategy: storeRetry },
      );
      if ("reread" in done) reread += 1;
    } catch (error) {
      // An error the SDK raises for itself is thrown as it is.
      if (!(error instanceof DurableOperationError)) throw error;
      // The step's own error, as the SDK checkpointed it, so a replay
      // logs the same name.
      const name = error.cause?.name ?? error.name;
      await logOnly(ctx, `rerun-failed-${paper.pmcid}`, () => {
        logRerunFailed(paper.pmcid, name);
      });
    }
  }
  return reread;
}

export function makeRun(deps: Deps) {
  return async (_event: unknown, ctx: DurableContext): Promise<RunSummary> => {
    const { runId } = await ctx.step(
      "start",
      async () => Promise.resolve({ runId: `run-${deps.now()}` }),
      { retryStrategy: storeRetry },
    );

    let cursor: string | null = "*";
    let page = 0;
    let found = 0;
    let skipped = 0;
    let read = 0;
    let failed = 0;
    let reread = 0;
    let owed: Owed = null;
    // How the search stopped early, if it did: a refused page leaves the
    // wait Europe PMC asked for, and a page that failed after its retries
    // leaves what it threw.
    let stopped: { refused: Owed } | { failed: DurableOperationError } | null =
      null;
    while (cursor !== null) {
      const from: string = cursor;
      if (owed !== null) await ctx.wait(owed.name, { seconds: owed.seconds });
      owed = null;
      const searchStep = `search-${String(page)}`;
      let searched: Asked<Awaited<ReturnType<typeof searchPage>>>;
      try {
        searched = await askEuropePmc(
          ctx,
          searchStep,
          `${searchStep}-wait`,
          europePmcRetry,
          async () => searchPage(deps, from),
        );
      } catch (error) {
        // An error the SDK raises for itself is not a failed page, so it
        // is thrown as it is, before any other durable operation.
        if (!(error instanceof DurableOperationError)) throw error;
        stopped = { failed: error };
        break;
      }
      if ("owed" in searched) {
        stopped = { refused: searched.owed };
        break;
      }
      const result = searched.read;
      // The table's own step, so a failure to write or read it is retried
      // under the store's strategy and never asks Europe PMC again.
      const { todo, once, rerun } = await ctx.step(
        `record-${String(page)}`,
        async () => recordPage(deps, result.papers, runId),
        { retryStrategy: storeRetry },
      );
      found += result.papers.length;
      skipped += result.skipped;
      // No paper here asks Europe PMC, so none waits on a wait still owed.
      // The list comes from the record step's result
      // (docs/constraints/durable-execution.md).
      for (const [index, batch] of batches(rerun, BATCH).entries()) {
        const name = `rerun-${String(page)}-${String(index)}`;
        reread += await ctx.runInChildContext(name, async (child) =>
          rerunBatch(child, deps, batch, runId),
        );
        await ctx.wait(`rest-${name}`, { seconds: 1 });
      }
      for (const [index, batch] of batches(todo, BATCH).entries()) {
        const name = `papers-${String(page)}-${String(index)}`;
        const outcome = await ctx.runInChildContext(name, async (child) =>
          readBatch(child, deps, batch, once, runId, owed),
        );
        read += outcome.read;
        failed += outcome.failed;
        owed = outcome.owed;
        await ctx.wait(`rest-${String(page)}-${String(index)}`, {
          seconds: 1,
        });
      }
      cursor = result.nextCursor;
      page += 1;
    }
    // Logged before the check, so a search that fails it still says how
    // many results it skipped, and before a refusal or a failed page ends
    // the run, so the totals of the pages it read still show in one line
    // (#348).
    const ended = stopped;
    // A failure to log it does not end the run (#380).
    await logOnly(ctx, "search-ended", () => {
      logSearchEnded(
        runId,
        found,
        skipped,
        ended !== null && "refused" in ended,
        ended !== null && "failed" in ended,
      );
    });
    if (ended !== null && "failed" in ended) throw ended.failed;
    // A refused search fails the run, which publishes nothing, but only
    // once the wait Europe PMC asked for has passed, so a run started
    // after this one never asks it too soon (#264).
    if (ended !== null) {
      const wait = ended.refused;
      if (wait !== null) await ctx.wait(wait.name, { seconds: wait.seconds });
      throw new Error(
        `Europe PMC refused the run's search, asked to wait ${String(wait?.seconds ?? 0)}s`,
      );
    }
    checkWholeSearch(found, skipped);

    // The search has ended, so the run records it once as the latest
    // complete one, and the page lists the papers the latest complete search
    // returned, whichever run publishes it (#125). A search that found
    // nothing is not recorded, so it never empties the page.
    let published: Published;
    if (found === 0) {
      published = { published: false, reason: "the search found nothing" };
    } else {
      // Neither step asks Europe PMC, so neither waits on a wait still owed
      // (#179). But a failure in either ends the run, so the run waits that
      // out before it throws, and a run started after it never asks Europe
      // PMC too soon (#412). An error the SDK raises for itself is thrown as
      // it is.
      try {
        await ctx.step("searched", async () => recordSearch(deps, runId), {
          retryStrategy: storeRetry,
        });
        published = await ctx.step(
          "publish",
          async () => publish(deps, runId),
          { retryStrategy: storeRetry },
        );
      } catch (error) {
        if (!(error instanceof DurableOperationError) || owed === null) {
          throw error;
        }
        await ctx.wait(owed.name, { seconds: owed.seconds });
        throw error;
      }
    }

    // The eval snapshot, once, after the page is published, so the page
    // never waits on it, not even for a wait a refusal left owed: the
    // snapshot waits that out before it asks Europe PMC. A snapshot that
    // fails is left for the next run.
    let snapshot: SnapshotSummary;
    let last: Owed;
    try {
      ({ snapshot, owed: last } = await ctx.runInChildContext(
        "snapshot",
        async (child) => takeSnapshot(child, deps, runId, owed),
      ));
    } catch (error) {
      snapshot = { taken: false, reason: "failed" };
      // Only a fixed reason is logged, never the message, which a store's
      // or Europe PMC's client wrote (docs/constraints/personal-data.md).
      const why = snapshotFailure(error);
      // A failure to log it does not skip the wait below (#380).
      await logOnly(ctx, "snapshot-failed", () => {
        logSnapshotFailed(runId, why);
      });
      // The snapshot may have waited this out under its own name already,
      // so waiting again takes a name of its own.
      last =
        owed === null ? null : { ...owed, name: `${owed.name}-after-snapshot` };
    }
    // A wait still owed is waited out before the run ends, so a run started
    // after this one never asks Europe PMC before it has passed.
    if (last !== null) await ctx.wait(last.name, { seconds: last.seconds });
    return {
      runId,
      found,
      skipped,
      read,
      failed,
      reread,
      published,
      snapshot,
    };
  };
}
