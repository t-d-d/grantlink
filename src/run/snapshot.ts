import {
  DurableOperationError,
  type DurableContext,
} from "@aws/durable-execution-sdk-js";
import {
  checkWholeSearch,
  logGoldBEmpty,
  logGoldPaperFailed,
  logGoldSearchEnded,
  logSnapshotFailed,
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
import { logOnly } from "./log-only.ts";
import {
  askEuropePmc,
  askForPaper,
  type Asked,
  type Owed,
  type PaperAsked,
} from "./owed.ts";
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
// its first paper that fails, since the snapshot is lost then and asking
// Europe PMC about the rest would be wasted, and names that paper in
// `stopped`. A gold set B paper is always kept once read (#399), so one
// that is not kept is a fault, and stops the batch the same way. `empty`
// names each paper kept with no funding text or awards.
async function takeBatch(
  ctx: DurableContext,
  deps: Deps,
  pmcids: string[],
  set: "A" | "B",
  owed: Owed,
): Promise<{
  entries: Entry[];
  empty: string[];
  failed: number;
  owed: Owed;
  stopped: string | null;
}> {
  const entries: Entry[] = [];
  const empty: string[] = [];
  let failed = 0;
  let stopped: string | null = null;
  let due = owed;
  for (const pmcid of pmcids) {
    if (due !== null) await ctx.wait(due.name, { seconds: due.seconds });
    due = null;
    let asked: PaperAsked<Taken>;
    try {
      asked = await askForPaper(
        ctx,
        `gold-${set}-${pmcid}`,
        `gold-${set}-${pmcid}-wait`,
        paperRetry,
        () => deps.europePmc.sent(),
        async () => snapshotPaper(deps, pmcid, set),
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
      if (asked.read.kept) {
        entries.push(asked.read.entry);
        if (asked.read.empty === true) empty.push(pmcid);
      } else if (set === "B") {
        stopped = pmcid;
        break;
      }
      continue;
    }
    failed += 1;
    const { failed: failure } = asked;
    await logOnly(ctx, `gold-${set}-${pmcid}-failed`, () => {
      logGoldPaperFailed(pmcid, set, failure);
    });
    // As in a run's batch: nothing more goes to Europe PMC until the wait
    // it asked for has passed.
    due = asked.owed;
    if (set === "B") {
      stopped = pmcid;
      break;
    }
  }
  return { entries, empty, failed, owed: due, stopped };
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
    // What a page that failed after its retries without a refusal threw.
    let failed: { error: unknown } | null = null;
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
        // An error the SDK raises for itself is not a failed page, so it
        // is thrown as it is, before any other durable operation.
        if (!(error instanceof DurableOperationError)) throw error;
        failed = { error };
        break;
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
    // many results it skipped, and before a refusal or a failed page ends
    // it, so the totals of the pages it read still show in one line (#307,
    // #348). The line only reports, so when its step fails the search's
    // own judgment below still decides how the snapshot ends, not that
    // failure (#370).
    await logOnly(ctx, "snapshot-search-ended", () => {
      logGoldSearchEnded(
        runId,
        deps.gold.snapshotId,
        found.length,
        skipped,
        refused !== null,
        failed !== null,
      );
    });
    if (failed !== null) failedAs("search-failed", failed.error);
    // A refused search loses the snapshot for this run, and leaves the
    // wait Europe PMC asked for owed, which the run waits out before it
    // ends (#236). The run logs it as a failure, as it does one the
    // snapshot throws (#399).
    if (refused !== null) {
      await logOnly(ctx, "snapshot-not-taken", () => {
        logSnapshotFailed(runId, "search-refused");
      });
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
  const empty: string[] = [];
  for (let i = 0; i * BATCH < labelled.length; i += 1) {
    const batch = labelled.slice(i * BATCH, (i + 1) * BATCH);
    const outcome = await ctx.runInChildContext(
      `snapshot-b-${String(i)}`,
      async (child) => takeBatch(child, deps, batch, "B", due),
    );
    due = outcome.owed;
    if (outcome.failed > 0 || outcome.entries.length < batch.length) {
      const { stopped } = outcome;
      await logOnly(ctx, "snapshot-not-taken", () => {
        logSnapshotFailed(
          runId,
          "gold-paper-failed",
          stopped === null ? undefined : { pmcid: stopped, set: "B" },
        );
      });
      return {
        snapshot: {
          taken: false,
          reason: "a gold set B paper could not be read",
        },
        owed: due,
      };
    }
    entries.push(...outcome.entries);
    empty.push(...outcome.empty);
  }

  // The gold set B papers kept with empty sections although their label
  // lists references, logged once whether there are any or not (#405).
  const referenced = new Set(
    goldB.papers
      .filter((paper) => paper.references.length > 0)
      .map((paper) => paper.pmcid),
  );
  const missed = empty.filter((pmcid) => referenced.has(pmcid));
  await logOnly(ctx, "snapshot-b-empty", () => {
    logGoldBEmpty(runId, deps.gold.snapshotId, missed);
  });

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
