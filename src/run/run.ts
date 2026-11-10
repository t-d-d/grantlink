import type { DurableContext } from "@aws/durable-execution-sdk-js";
import {
  checkWholeSearch,
  logSearchEnded,
  logSnapshotFailed,
  markFailed,
  publish,
  readPaper,
  recordPage,
  recordSearch,
  searchPage,
  type Deps,
  type Published,
} from "../pipeline/steps.ts";
import { batches } from "../shared/batches.ts";
import { readOrRefused, type Read } from "../pipeline/refused.ts";
import { owedAfter, type Owed } from "./owed.ts";
import { europePmcRetry, paperRetry, storeRetry } from "./retry.ts";
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
  published: Published;
  snapshot: SnapshotSummary;
}

interface BatchOutcome {
  read: number;
  failed: number;
  owed: Owed;
}

// Reads a batch of papers, first waiting out any wait an earlier refusal
// left `owed`. It returns the wait its own last refusal leaves owed, if no
// paper after it has paid it.
async function readBatch(
  ctx: DurableContext,
  deps: Deps,
  pmcids: string[],
  runId: string,
  owed: Owed,
): Promise<BatchOutcome> {
  let read = 0;
  let failed = 0;
  let due = owed;
  for (const pmcid of pmcids) {
    if (due !== null) await ctx.wait(due.name, { seconds: due.seconds });
    due = null;
    let outcome: Read<{ references: number }> | undefined;
    try {
      outcome = await ctx.step(
        `paper-${pmcid}`,
        async ({ attempt }) =>
          readOrRefused(attempt, paperRetry, async () =>
            readPaper(deps, pmcid, runId),
          ),
        { retryStrategy: paperRetry },
      );
    } catch {
      outcome = undefined;
    }
    if (outcome !== undefined && "read" in outcome) {
      read += 1;
      continue;
    }
    failed += 1;
    await ctx.step(`failed-${pmcid}`, async () => markFailed(deps, pmcid), {
      retryStrategy: storeRetry,
    });
    // Europe PMC asked the run to wait before it asks again, so whatever
    // asks it next waits first (docs/constraints/europe-pmc.md).
    due = owedAfter(`wait-${pmcid}`, outcome);
  }
  return { read, failed, owed: due };
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
    let owed: Owed = null;
    while (cursor !== null) {
      const from: string = cursor;
      if (owed !== null) await ctx.wait(owed.name, { seconds: owed.seconds });
      owed = null;
      const result = await ctx.step(
        `search-${String(page)}`,
        async () => searchPage(deps, from),
        { retryStrategy: europePmcRetry },
      );
      // The table's own step, so a failure to write or read it is retried
      // under the store's strategy and never asks Europe PMC again.
      const todo = await ctx.step(
        `record-${String(page)}`,
        async () => recordPage(deps, result.papers, runId),
        { retryStrategy: storeRetry },
      );
      found += result.papers.length;
      skipped += result.skipped;
      for (const [index, batch] of batches(todo, BATCH).entries()) {
        const name = `papers-${String(page)}-${String(index)}`;
        const outcome = await ctx.runInChildContext(name, async (child) =>
          readBatch(child, deps, batch, runId, owed),
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
    // many results it skipped.
    await ctx.step(
      "search-ended",
      async () => {
        logSearchEnded(runId, found, skipped);
        return Promise.resolve();
      },
      { retryStrategy: storeRetry },
    );
    checkWholeSearch(found, skipped);

    // The search has ended, so the run records it once as the latest
    // complete one, and the page lists the papers the latest complete search
    // returned, whichever run publishes it (#125). A search that found
    // nothing is not recorded, so it never empties the page.
    let published: Published;
    if (found === 0) {
      published = { published: false, reason: "the search found nothing" };
    } else {
      await ctx.step("searched", async () => recordSearch(deps, runId), {
        retryStrategy: storeRetry,
      });
      published = await ctx.step("publish", async () => publish(deps, runId), {
        retryStrategy: storeRetry,
      });
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
      // What reaches here is a message this code wrote or a store's or
      // Europe PMC's client's, made of ids, counts and statuses: a gold
      // paper's own failure is caught in its batch, so no paper's text is
      // in it (docs/constraints/personal-data.md). A reply that fails its
      // schema can list an issue per result, so the message is cut short.
      const why = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 500);
      await ctx.step(
        "snapshot-failed",
        async () => {
          logSnapshotFailed(runId, why);
          return Promise.resolve();
        },
        { retryStrategy: storeRetry },
      );
      // The snapshot may have waited this out under its own name already,
      // so waiting again takes a name of its own.
      last =
        owed === null ? null : { ...owed, name: `${owed.name}-after-snapshot` };
    }
    // A wait still owed is waited out before the run ends, so a run started
    // after this one never asks Europe PMC before it has passed.
    if (last !== null) await ctx.wait(last.name, { seconds: last.seconds });
    return { runId, found, skipped, read, failed, published, snapshot };
  };
}
