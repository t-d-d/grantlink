import type { DurableContext } from "@aws/durable-execution-sdk-js";
import { goldA, goldB } from "../../evals/gold.ts";
import type { Deps } from "../pipeline/steps.ts";
import {
  sample,
  searchGoldA,
  snapshotPaper,
  snapshotTaken,
  writeManifest,
  type Entry,
  type Taken,
} from "../pipeline/snapshot.ts";
import { readOrRefused, type Read } from "../pipeline/refused.ts";
import { owedAfter, type Owed } from "./owed.ts";
import { europePmcRetry, paperRetry, storeRetry } from "./retry.ts";

// Takes the eval snapshot named in evals/snapshot.json, once
// (docs/constraints/evals.md). A run calls this after it publishes, so the
// page never waits on it. Gold set A comes from the papers the repo lists,
// or before there are any, from a sample drawn with the recorded query and
// seed. Gold set B's papers come from its labels.

export type SnapshotSummary =
  | { taken: true; papers: number; manifestSha256: string }
  | { taken: false; reason: string };

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
    let outcome: Read<Taken> | undefined;
    try {
      outcome = await ctx.step(
        `gold-${set}-${pmcid}`,
        async ({ attempt }) =>
          readOrRefused(attempt, paperRetry, async () =>
            snapshotPaper(deps, pmcid, set),
          ),
        { retryStrategy: paperRetry },
      );
    } catch {
      outcome = undefined;
    }
    if (outcome !== undefined && "read" in outcome) {
      if (outcome.read.kept) entries.push(outcome.read.entry);
      else if (set === "B") break;
      continue;
    }
    failed += 1;
    // As in a run's batch: nothing more goes to Europe PMC until the wait
    // it asked for has passed.
    due = owedAfter(`gold-${set}-${pmcid}-wait`, outcome);
    if (set === "B") break;
  }
  return { entries, failed, owed: due };
}

// `owed` is a wait the run's last refusal left, which the snapshot waits
// out before it first asks Europe PMC. It returns whatever wait is still
// owed when it ends, which the run waits out before it ends, so no run
// started after it asks Europe PMC too soon.
export async function takeSnapshot(
  ctx: DurableContext,
  deps: Deps,
  owed: Owed,
): Promise<{ snapshot: SnapshotSummary; owed: Owed }> {
  const done = await ctx.step(
    "snapshot-check",
    async () => snapshotTaken(deps),
    { retryStrategy: storeRetry },
  );
  if (done)
    return { snapshot: { taken: false, reason: "already taken" }, owed };
  let due = owed;

  // The order gold set A is drawn in.
  let candidates: string[] = goldA.papers.map((paper) => paper.pmcid);
  if (candidates.length === 0) {
    const found: string[] = [];
    let cursor: string | null = "*";
    let page = 0;
    while (cursor !== null) {
      const from: string = cursor;
      if (due !== null) await ctx.wait(due.name, { seconds: due.seconds });
      due = null;
      const result = await ctx.step(
        `snapshot-search-${String(page)}`,
        async () => searchGoldA(deps, from),
        { retryStrategy: europePmcRetry },
      );
      found.push(...result.pmcids);
      cursor = result.nextCursor;
      page += 1;
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

  const written = await ctx.step(
    "snapshot-manifest",
    async () => writeManifest(deps, entries),
    { retryStrategy: storeRetry },
  );
  return {
    snapshot: {
      taken: true,
      papers: entries.length,
      manifestSha256: written.manifestSha256,
    },
    owed: due,
  };
}
