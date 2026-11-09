import {
  createRetryStrategy,
  type DurableContext,
  type RetryDecision,
} from "@aws/durable-execution-sdk-js";
import {
  markFailed,
  publish,
  readPaper,
  searchPage,
  type Deps,
  type Published,
} from "../pipeline/steps.ts";
import { batches } from "../shared/batches.ts";

// A run: search Europe PMC page by page, read each paper not yet read, then
// publish the page. Every I/O call sits in a step
// (docs/constraints/durable-execution.md). A paper that fails is left for
// the next run. A run that fails, or whose search finds nothing, publishes
// nothing. Otherwise it publishes if the table holds any paper read, by
// this run or an earlier one (publish in src/pipeline/steps.ts).

// Papers per child context. Each batch ends with a short wait, so each
// Lambda invocation does a bounded amount of work, and a replay skips each
// finished batch whole.
export const BATCH = 50;

// Europe PMC's client already paces and backs off within one try. A step
// that still fails waits longer, up to five minutes, before the next.
const europePmcRetry = createRetryStrategy({
  maxAttempts: 3,
  initialDelay: { seconds: 30 },
  maxDelay: { minutes: 5 },
});

// Only Europe PMC's own refusals and failures are worth asking again in
// this run, after the longer wait. A paper it has no full text for (a 4xx
// other than 429) is not, and nor is a fault in the paper or the code,
// which gives the same result however often it is tried.
const paperRetry = (error: Error, attempt: number): RetryDecision =>
  error.name === "EuropePmcError" &&
  !/answered 4(?!29)\d\d/u.test(error.message)
    ? europePmcRetry(error, attempt)
    : { shouldRetry: false };

const storeRetry = createRetryStrategy({
  maxAttempts: 3,
  initialDelay: { seconds: 5 },
});

export interface RunSummary {
  runId: string;
  found: number;
  read: number;
  failed: number;
  published: Published;
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
      found += result.found;
      for (const [index, batch] of batches(result.todo, BATCH).entries()) {
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
    return { runId, found, read, failed, published };
  };
}
