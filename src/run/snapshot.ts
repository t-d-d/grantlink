import type { DurableContext } from "@aws/durable-execution-sdk-js";
import { checkWholeSearch } from "../europepmc/client.ts";
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

async function takeBatch(
  ctx: DurableContext,
  deps: Deps,
  pmcids: string[],
  set: "A" | "B",
): Promise<{ entries: Entry[]; failed: number }> {
  const entries: Entry[] = [];
  let failed = 0;
  for (const pmcid of pmcids) {
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
      continue;
    }
    failed += 1;
    // As in a run's batch: nothing more goes to Europe PMC until the wait
    // it asked for has passed.
    if (outcome !== undefined && outcome.waitSeconds > 0) {
      await ctx.wait(`gold-${set}-${pmcid}-wait`, {
        seconds: outcome.waitSeconds,
      });
    }
  }
  return { entries, failed };
}

export async function takeSnapshot(
  ctx: DurableContext,
  deps: Deps,
): Promise<SnapshotSummary> {
  const done = await ctx.step(
    "snapshot-check",
    async () => snapshotTaken(deps),
    { retryStrategy: storeRetry },
  );
  if (done) return { taken: false, reason: "already taken" };

  // The order gold set A is drawn in.
  let candidates: string[] = goldA.papers.map((paper) => paper.pmcid);
  if (candidates.length === 0) {
    const found: string[] = [];
    let skipped = 0;
    let cursor: string | null = "*";
    let page = 0;
    while (cursor !== null) {
      const from: string = cursor;
      const result = await ctx.step(
        `snapshot-search-${String(page)}`,
        async () => searchGoldA(deps, from),
        { retryStrategy: europePmcRetry },
      );
      found.push(...result.pmcids);
      skipped += result.skipped;
      cursor = result.nextCursor;
      page += 1;
    }
    checkWholeSearch(found.length, skipped);
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
      async (child) => takeBatch(child, deps, batch, "A"),
    );
    entries.push(...outcome.entries);
    keptA += outcome.entries.length;
    at += batch.length;
    await ctx.wait(`snapshot-a-rest-${String(index)}`, { seconds: 1 });
    index += 1;
  }

  // Every labelled paper must be in the snapshot, or its labels score
  // nothing, so one that cannot be read leaves the snapshot for next time.
  const labelled = goldB.papers.map((paper) => paper.pmcid);
  for (let i = 0; i * BATCH < labelled.length; i += 1) {
    const batch = labelled.slice(i * BATCH, (i + 1) * BATCH);
    const outcome = await ctx.runInChildContext(
      `snapshot-b-${String(i)}`,
      async (child) => takeBatch(child, deps, batch, "B"),
    );
    if (outcome.failed > 0 || outcome.entries.length < batch.length) {
      return { taken: false, reason: "a gold set B paper could not be read" };
    }
    entries.push(...outcome.entries);
  }

  const written = await ctx.step(
    "snapshot-manifest",
    async () => writeManifest(deps, entries),
    { retryStrategy: storeRetry },
  );
  return {
    taken: true,
    papers: entries.length,
    manifestSha256: written.manifestSha256,
  };
}
