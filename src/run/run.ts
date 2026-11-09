import type { DurableContext } from "@aws/durable-execution-sdk-js";
import {
  markFailed,
  publish,
  readPaper,
  recordPage,
  searchPage,
  type Deps,
  type Published,
} from "../pipeline/steps.ts";
import { batches } from "../shared/batches.ts";
import { europePmcRetry, paperRetry, storeRetry } from "./retry.ts";
import { takeSnapshot, type SnapshotSummary } from "./snapshot.ts";

// A run: search Europe PMC page by page, record what each page found, read
// each paper not yet read, then publish the page. Every I/O call sits in a
// step (docs/constraints/durable-execution.md). A paper that fails is left for
// the next run. A run that fails, or whose search finds nothing, publishes
// nothing, with one exception: publish writes found.json before the page, so
// a run whose page write fails on every try leaves its found.json on the site
// (siteBucket.publish in src/store/bucket.ts, and the README). Otherwise it
// publishes if any paper its own search returned has been read, by this run
// or an earlier one (publish in src/pipeline/steps.ts).

// Papers per child context. Each batch ends with a short wait, so each
// Lambda invocation does a bounded amount of work, and a replay skips each
// finished batch whole.
export const BATCH = 50;

export interface RunSummary {
  runId: string;
  found: number;
  read: number;
  failed: number;
  published: Published;
  snapshot: SnapshotSummary;
}

interface BatchOutcome {
  read: number;
  failed: number;
}

async function readBatch(
  ctx: DurableContext,
  deps: Deps,
  pmcids: string[],
  runId: string,
): Promise<BatchOutcome> {
  let read = 0;
  let failed = 0;
  for (const pmcid of pmcids) {
    try {
      await ctx.step(
        `paper-${pmcid}`,
        async () => readPaper(deps, pmcid, runId),
        { retryStrategy: paperRetry },
      );
      read += 1;
    } catch {
      failed += 1;
      await ctx.step(`failed-${pmcid}`, async () => markFailed(deps, pmcid), {
        retryStrategy: storeRetry,
      });
    }
  }
  return { read, failed };
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
    let read = 0;
    let failed = 0;
    while (cursor !== null) {
      const from: string = cursor;
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
      for (const [index, batch] of batches(todo, BATCH).entries()) {
        const name = `papers-${String(page)}-${String(index)}`;
        const outcome = await ctx.runInChildContext(name, async (child) =>
          readBatch(child, deps, batch, runId),
        );
        read += outcome.read;
        failed += outcome.failed;
        await ctx.wait(`rest-${String(page)}-${String(index)}`, {
          seconds: 1,
        });
      }
      cursor = result.nextCursor;
      page += 1;
    }

    const published: Published =
      found === 0
        ? { published: false, reason: "the search found nothing" }
        : await ctx.step("publish", async () => publish(deps, runId), {
            retryStrategy: storeRetry,
          });

    // The eval snapshot, once, after the page is published, so the page
    // never waits on it. A snapshot that fails is left for the next run.
    let snapshot: SnapshotSummary;
    try {
      snapshot = await ctx.runInChildContext("snapshot", async (child) =>
        takeSnapshot(child, deps),
      );
    } catch {
      snapshot = { taken: false, reason: "failed" };
    }
    return { runId, found, read, failed, published, snapshot };
  };
}
