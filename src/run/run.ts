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
// the README). Otherwise a run publishes if any paper its own search returned
// has been read, by this run or an earlier one (publish in
// src/pipeline/steps.ts).

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

    const published: Published =
      found === 0
        ? { published: false, reason: "the search found nothing" }
        : await ctx.step("publish", async () => publish(deps, runId), {
            retryStrategy: storeRetry,
          });

    // The eval snapshot, once, after the page is published, so the page
    // never waits on it, not even for a wait a refusal left owed: the
    // snapshot waits that out before it asks Europe PMC. A snapshot that
    // fails is left for the next run.
    let snapshot: SnapshotSummary;
    try {
      snapshot = await ctx.runInChildContext("snapshot", async (child) =>
        takeSnapshot(child, deps, owed),
      );
    } catch {
      snapshot = { taken: false, reason: "failed" };
    }
    return { runId, found, read, failed, published, snapshot };
  };
}
