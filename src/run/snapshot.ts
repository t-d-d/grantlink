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
// page never waits on it. Gold sets A and A2 come from the papers the gold
// lists, or before there are any, from a sample drawn with the set's query
// and seed. Gold set B's and B2's papers come from their labels.

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
// refusal left `owed`, as a run's batch does. A gold set B or B2 batch
// stops at its first paper that fails, since the snapshot is lost then and
// asking Europe PMC about the rest would be wasted, and names that paper in
// `stopped`. A labelled paper is always kept once read (#399), so one
// that is not kept is a fault, and stops the batch the same way. `empty`
// names each paper kept with no funding text or awards.
async function takeBatch(
  ctx: DurableContext,
  deps: Deps,
  pmcids: string[],
  set: "A" | "A2" | "B" | "B2",
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
  const labelled = set === "B" || set === "B2";
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
        if (asked.read.empty) empty.push(pmcid);
      } else if (labelled) {
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
    if (labelled) {
      stopped = pmcid;
      break;
    }
  }
  return { entries, empty, failed, owed: due, stopped };
}

// What a drawn set's search found, or how losing it ends the snapshot.
type Searched =
  | { found: string[]; owed: Owed }
  | { lost: { snapshot: SnapshotSummary; owed: Owed } };

// Searches with a drawn set's query, page by page, as a run searches.
// Gold set A's steps keep the names they had before gold set A2 joined;
// gold set A2's, when it searches on its own, are named for it (#695).
async function searchDrawn(
  ctx: DurableContext,
  deps: Deps,
  runId: string,
  query: string,
  set: "A" | "A2",
  owed: Owed,
): Promise<Searched> {
  const prefix = set === "A" ? "snapshot-search" : "snapshot-a2-search";
  let due = owed;
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
    const name = `${prefix}-${String(page)}`;
    let asked: Asked<Awaited<ReturnType<typeof searchGoldA>>>;
    try {
      asked = await askEuropePmc(
        ctx,
        name,
        `${name}-wait`,
        europePmcRetry,
        async () => searchGoldA(deps, from, query),
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
  await logOnly(ctx, `${prefix}-ended`, () => {
    logGoldSearchEnded(
      runId,
      deps.gold.snapshotId,
      found.length,
      skipped,
      refused !== null,
      failed !== null,
      set === "A" ? undefined : set,
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
      lost: {
        snapshot: {
          taken: false,
          reason: `Europe PMC refused gold set ${set}'s search`,
        },
        owed: refused.owed,
      },
    };
  }
  try {
    checkWholeSearch(found.length, skipped);
  } catch {
    throw new Error("malformed-search" satisfies KnownSnapshotFailure);
  }
  return { found, owed: due };
}

// Walks a drawn set's candidates in order, in batches, keeping papers
// until it has the set's size or runs out. Gold set A's steps keep the
// names they had before gold set A2 joined.
async function drawSet(
  ctx: DurableContext,
  deps: Deps,
  candidates: readonly string[],
  set: "A" | "A2",
  size: number,
  owed: Owed,
): Promise<{ entries: Entry[]; owed: Owed }> {
  const prefix = set === "A" ? "snapshot-a" : "snapshot-a2";
  let due = owed;
  const entries: Entry[] = [];
  let at = 0;
  let index = 0;
  while (entries.length < size && at < candidates.length) {
    const batch = candidates.slice(
      at,
      at + Math.min(BATCH, size - entries.length),
    );
    const outcome = await ctx.runInChildContext(
      `${prefix}-${String(index)}`,
      async (child) => takeBatch(child, deps, batch, set, due),
    );
    due = outcome.owed;
    entries.push(...outcome.entries);
    at += batch.length;
    await ctx.wait(`${prefix}-rest-${String(index)}`, { seconds: 1 });
    index += 1;
  }
  return { entries, owed: due };
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
  const { goldA, goldA2, goldB, goldB2 } = deps.gold;

  // What gold set A's search found, which gold set A2 reuses when it
  // shares gold set A's query, so it does not search again.
  let foundA: string[] | null = null;

  // The order gold set A is drawn in.
  let candidates: string[] = goldA.papers.map((paper) => paper.pmcid);
  if (candidates.length === 0) {
    // eslint-disable-next-line grantlink/no-await-outside-step -- every await in searchDrawn and drawSet is a durable operation or a step helper, so a replay takes the same path, as it did when this code was inline.
    const result = await searchDrawn(ctx, deps, runId, goldA.query, "A", due);
    if ("lost" in result) return result.lost;
    due = result.owed;
    foundA = result.found;
    candidates = sample(result.found, goldA.seed);
  }

  // Gold set A2 is drawn as gold set A is, with its own seed (#695). Its
  // search comes before any paper is read, so a search Europe PMC refuses
  // or that fails ends the snapshot before it has cost a paper.
  let candidatesA2: string[] = goldA2.papers.map((paper) => paper.pmcid);
  if (candidatesA2.length === 0) {
    let found = goldA2.query === goldA.query ? foundA : null;
    if (found === null) {
      // eslint-disable-next-line grantlink/no-await-outside-step -- every await in searchDrawn and drawSet is a durable operation or a step helper, so a replay takes the same path, as it did when this code was inline.
      const result = await searchDrawn(
        ctx,
        deps,
        runId,
        goldA2.query,
        "A2",
        due,
      );
      if ("lost" in result) return result.lost;
      due = result.owed;
      found = result.found;
    }
    candidatesA2 = sample(found, goldA2.seed);
  }

  // eslint-disable-next-line grantlink/no-await-outside-step -- every await in searchDrawn and drawSet is a durable operation or a step helper, so a replay takes the same path, as it did when this code was inline.
  const drawnA = await drawSet(ctx, deps, candidates, "A", goldA.size, due);
  due = drawnA.owed;
  const entries: Entry[] = [...drawnA.entries];

  // Gold set A2 passes over any candidate in gold set A, as the repo
  // pinned it or as this snapshot took it.
  const inA = new Set([
    ...goldA.papers.map((paper) => paper.pmcid),
    ...drawnA.entries.map((entry) => entry.pmcid),
  ]);
  // eslint-disable-next-line grantlink/no-await-outside-step -- every await in searchDrawn and drawSet is a durable operation or a step helper, so a replay takes the same path, as it did when this code was inline.
  const drawnA2 = await drawSet(
    ctx,
    deps,
    candidatesA2.filter((pmcid) => !inA.has(pmcid)),
    "A2",
    goldA2.size,
    due,
  );
  due = drawnA2.owed;
  entries.push(...drawnA2.entries);

  // Every labelled paper must be in the snapshot, or its labels score
  // nothing, so one that cannot be read leaves the snapshot for next time,
  // and the snapshot asks Europe PMC nothing more. Gold set B2's papers
  // are kept as gold set B's are, even with empty sections (#695).
  const empty = { B: [] as string[], B2: [] as string[] };
  for (const set of ["B", "B2"] as const) {
    const labelled = (set === "B" ? goldB : goldB2).papers.map(
      (paper) => paper.pmcid,
    );
    const prefix = set === "B" ? "snapshot-b" : "snapshot-b2";
    for (let i = 0; i * BATCH < labelled.length; i += 1) {
      const batch = labelled.slice(i * BATCH, (i + 1) * BATCH);
      const outcome = await ctx.runInChildContext(
        `${prefix}-${String(i)}`,
        async (child) => takeBatch(child, deps, batch, set, due),
      );
      due = outcome.owed;
      if (outcome.failed > 0 || outcome.entries.length < batch.length) {
        const { stopped } = outcome;
        await logOnly(ctx, "snapshot-not-taken", () => {
          logSnapshotFailed(
            runId,
            "gold-paper-failed",
            stopped === null ? undefined : { pmcid: stopped, set },
          );
        });
        return {
          snapshot: {
            taken: false,
            reason: `a gold set ${set} paper could not be read`,
          },
          owed: due,
        };
      }
      entries.push(...outcome.entries);
      empty[set].push(...outcome.empty);
    }
  }

  // The labelled papers kept with empty sections although their label
  // lists references. The snapshot logs gold set B's once it is taken,
  // whether there are any or not (#405), and gold set B2's in a line of
  // its own once it has papers.
  const missed = (labels: typeof goldB, kept: readonly string[]) => {
    const referenced = new Set(
      labels.papers
        .filter((paper) => paper.references.length > 0)
        .map((paper) => paper.pmcid),
    );
    return kept.filter((pmcid) => referenced.has(pmcid));
  };

  // A wait can still be owed here when gold sets B and B2 list no papers,
  // since nothing then has asked Europe PMC since gold set A's last refusal. If
  // the manifest write throws, the run loses what this returns, so the
  // snapshot waits that out before it throws (#284).
  try {
    const { manifestSha256 } = await ctx.step(
      "snapshot-manifest",
      async () => writeManifest(deps, entries),
      { retryStrategy: storeRetry },
    );
    await logOnly(ctx, "snapshot-b-empty", () => {
      logGoldBEmpty(runId, deps.gold.snapshotId, missed(goldB, empty.B));
    });
    if (goldB2.papers.length > 0) {
      await logOnly(ctx, "snapshot-b2-empty", () => {
        logGoldBEmpty(
          runId,
          deps.gold.snapshotId,
          missed(goldB2, empty.B2),
          "B2",
        );
      });
    }
    return {
      snapshot: { taken: true, papers: entries.length, manifestSha256 },
      owed: due,
    };
  } catch (error) {
    if (due !== null) await ctx.wait(due.name, { seconds: due.seconds });
    failedAs("store-failed", error);
  }
}
