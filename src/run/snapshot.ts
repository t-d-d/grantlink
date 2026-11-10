import {
  DurableOperationError,
  type DurableContext,
} from "@aws/durable-execution-sdk-js";
import {
  checkWholeSearch,
  logGoldSearchEnded,
  type Deps,
  type KnownSnapshotFailure,
} from "../pipeline/steps.ts";
import {
  sample,
  searchGoldA,
  snapshotPaper,
  snapshotTaken,
  writeManifest,
  type Entry,
  type Taken,
} from "../pipeline/snapshot.ts";
import { askEuropePmc, type Asked, type Owed } from "./owed.ts";
import { europePmcRetry, paperRetry, storeRetry } from "./retry.ts";

// Takes the eval snapshot named in the deps' gold, once
// (docs/constraints/evals.md). A run calls this after it publishes, so the
// page never waits on it. Gold set A comes from the papers the gold lists,
// or before there are any, from a sample drawn with its query and seed.
// Gold set B's papers come from its labels.

export type SnapshotSummary =
  | { taken: true; papers: number; manifestSha256: string }
  | { taken: false; reason: string };

// Throws `reason` in place of a durable operation's failure, whose message
// a store's or Europe PMC's client wrote, so the run logs the reason alone
// (docs/constraints/personal-data.md, #285). An error the SDK raises for
// itself, which is not an operation's failure, is thrown as it is.
function failedAs(reason: KnownSnapshotFailure, error: unknown): never {
  if (error instanceof DurableOperationError) throw new Error(reason);
  throw error;
}

// Gold papers per child context, each ending with a short wait, as a run's
// batches do.
const BATCH = 50;

// Takes a batch of gold papers, first waiting out any wait an earlier
// refusal left `owed`, as a run's batch does. A gold set B batch stops at
// its first paper that fails or is not kept, since the snapshot is lost
// then and asking Europe PMC about the rest would be wasted.
async function takeBatch(
  ctx: DurableContext,
  deps: Deps,
  pmcids: string[],
  set: "A" | "B",
  owed: Owed,
): Promise<{ entries: Entry[]; failed: number; owed: Owed }> {
  const entries: Entry[] = [];
  let failed = 0;
  let due = owed;
  for (const pmcid of pmcids) {
    if (due !== null) await ctx.wait(due.name, { seconds: due.seconds });
    due = null;
    let asked: Asked<Taken>;
    try {
      asked = await askEuropePmc(
        ctx,
        `gold-${set}-${pmcid}`,
        `gold-${set}-${pmcid}-wait`,
        paperRetry,
        async () => snapshotPaper(deps, pmcid, set),
      );
    } catch {
      asked = { owed: null };
    }
    if ("read" in asked) {
      if (asked.read.kept) entries.push(asked.read.entry);
      else if (set === "B") break;
      continue;
    }
    failed += 1;
    // As in a run's batch: nothing more goes to Europe PMC until the wait
    // it asked for has passed.
    due = asked.owed;
    if (set === "B") break;
  }
  return { entries, failed, owed: due };
}

// `owed` is a wait the run's last refusal left, which the snapshot waits
// out before it first asks Europe PMC, and `runId` names the run in its
// logs. It returns whatever wait is still owed when it ends, which the run
// waits out before it ends, so no run started after it asks Europe PMC too
// soon.
export async function takeSnapshot(
  ctx: DurableContext,
  deps: Deps,
  runId: string,
  owed: Owed,
): Promise<{ snapshot: SnapshotSummary; owed: Owed }> {
  let done: boolean;
  try {
    done = await ctx.step("snapshot-check", async () => snapshotTaken(deps), {
      retryStrategy: storeRetry,
    });
  } catch (error) {
    failedAs("store-failed", error);
  }
  if (done)
    return { snapshot: { taken: false, reason: "already taken" }, owed };
  let due = owed;
  const { goldA, goldB } = deps.gold;

  // The order gold set A is drawn in.
  let candidates: string[] = goldA.papers.map((paper) => paper.pmcid);
  if (candidates.length === 0) {
    const found: string[] = [];
    let skipped = 0;
    let cursor: string | null = "*";
    let page = 0;
    // The wait a refused page leaves owed, once Europe PMC has refused one.
    let refused: { owed: Owed } | null = null;
    while (cursor !== null) {
      const from: string = cursor;
      if (due !== null) await ctx.wait(due.name, { seconds: due.seconds });
      due = null;
      const name = `snapshot-search-${String(page)}`;
      let asked: Asked<Awaited<ReturnType<typeof searchGoldA>>>;
      try {
        asked = await askEuropePmc(
          ctx,
          name,
          `${name}-wait`,
          europePmcRetry,
          async () => searchGoldA(deps, from),
        );
      } catch (error) {
        failedAs("search-failed", error);
      }
      if ("owed" in asked) {
        refused = { owed: asked.owed };
        break;
      }
      const result = asked.read;
      found.push(...result.pmcids);
      skipped += result.skipped;
      cursor = result.nextCursor;
      page += 1;
    }
    // Logged before the check, so a search that fails it still says how
    // many results it skipped, and before a refusal ends it, so the totals
    // of the pages it read still show in one line (#307). The line only
    // reports, so when its step fails the search's own judgment below
    // still decides how the snapshot ends, not that failure (#370).
    try {
      await ctx.step(
        "snapshot-search-ended",
        async () => {
          logGoldSearchEnded(
            runId,
            deps.gold.snapshotId,
            found.length,
            skipped,
            refused !== null,
          );
          return Promise.resolve();
        },
        { retryStrategy: storeRetry },
      );
    } catch (error) {
      if (!(error instanceof DurableOperationError)) throw error;
    }
    // A refused search loses the snapshot for this run, and leaves the
    // wait Europe PMC asked for owed, which the run waits out before it
    // ends (#236).
    if (refused !== null) {
      return {
        snapshot: {
          taken: false,
          reason: "Europe PMC refused gold set A's search",
        },
        owed: refused.owed,
      };
    }
    try {
      checkWholeSearch(found.length, skipped);
    } catch {
      throw new Error("malformed-search" satisfies KnownSnapshotFailure);
    }
    candidates = sample(found, goldA.seed);
  }

  const entries: Entry[] = [];
  let keptA = 0;
  let at = 0;
  let index = 0;
  while (keptA < goldA.size && at < candidates.length) {
    const batch = candidates.slice(
      at,
      at + Math.min(BATCH, goldA.size - keptA),
    );
    const outcome = await ctx.runInChildContext(
      `snapshot-a-${String(index)}`,
      async (child) => takeBatch(child, deps, batch, "A", due),
    );
    due = outcome.owed;
    entries.push(...outcome.entries);
    keptA += outcome.entries.length;
    at += batch.length;
    await ctx.wait(`snapshot-a-rest-${String(index)}`, { seconds: 1 });
    index += 1;
  }

  // Every labelled paper must be in the snapshot, or its labels score
  // nothing, so one that cannot be read leaves the snapshot for next time,
  // and the snapshot asks Europe PMC nothing more.
  const labelled = goldB.papers.map((paper) => paper.pmcid);
  for (let i = 0; i * BATCH < labelled.length; i += 1) {
    const batch = labelled.slice(i * BATCH, (i + 1) * BATCH);
    const outcome = await ctx.runInChildContext(
      `snapshot-b-${String(i)}`,
      async (child) => takeBatch(child, deps, batch, "B", due),
    );
    due = outcome.owed;
    if (outcome.failed > 0 || outcome.entries.length < batch.length) {
      return {
        snapshot: {
          taken: false,
          reason: "a gold set B paper could not be read",
        },
        owed: due,
      };
    }
    entries.push(...outcome.entries);
  }

  // A wait can still be owed here when gold set B lists no papers, since
  // nothing then has asked Europe PMC since gold set A's last refusal. If
  // the manifest write throws, the run loses what this returns, so the
  // snapshot waits that out before it throws (#284).
  try {
    const { manifestSha256 } = await ctx.step(
      "snapshot-manifest",
      async () => writeManifest(deps, entries),
      { retryStrategy: storeRetry },
    );
    return {
      snapshot: { taken: true, papers: entries.length, manifestSha256 },
      owed: due,
    };
  } catch (error) {
    if (due !== null) await ctx.wait(due.name, { seconds: due.seconds });
    failedAs("store-failed", error);
  }
}
