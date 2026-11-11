import { readFile } from "node:fs/promises";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { z } from "zod";
import { goldA, goldA2, goldB, goldB2, pinned } from "../../evals/gold.ts";
import { europePmc } from "../europepmc/client.ts";
import { release } from "../page/release.ts";
import type { Deps } from "../pipeline/steps.ts";
import { siteBucket, textBucket } from "../store/bucket.ts";
import { dynamoTable } from "../store/table.ts";
import { makeRun } from "./run.ts";

// The Lambda function's handler. serverless.yml sets the environment.
const env = z
  .object({
    TABLE_NAME: z.string().min(1),
    TEXT_BUCKET: z.string().min(1),
    SITE_BUCKET: z.string().min(1),
    CODE_VERSION: z.string().min(1).max(40),
  })
  .parse(process.env);

// The page's template is deployed with the function.
const TEMPLATE = new URL("../../site/index.html", import.meta.url);
// So is the release record, which the deploy writes before it packages the
// function. A function packaged without one shows no release.
const RELEASE = new URL("../../site/release.json", import.meta.url);

// Called only from inside the publish step.
const readRelease = () =>
  readFile(RELEASE, "utf8").then(
    (text) => release.parse(JSON.parse(text)),
    (error: unknown) => {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    },
  );

// Made for each invocation, so no state, such as the Europe PMC client's
// pace, carries from one run into the next.
export function liveDeps(): Deps {
  return {
    europePmc: europePmc(),
    table: dynamoTable(env.TABLE_NAME),
    text: textBucket(env.TEXT_BUCKET),
    site: siteBucket(env.SITE_BUCKET),
    template: () => readFile(TEMPLATE, "utf8"),
    release: readRelease,
    codeVersion: env.CODE_VERSION,
    // Only a step's helpers call this, so every clock read sits in a step.
    // eslint-disable-next-line grantlink/no-non-deterministic-outside-step -- called only from inside steps
    now: () => new Date().toISOString(),
    // The repo's own gold sets, and the snapshot id evals/snapshot.json
    // pins.
    gold: { goldA, goldA2, goldB, goldB2, snapshotId: pinned.id },
  };
}

export const handler = withDurableExecution(async (event, ctx) =>
  makeRun(liveDeps())(event, ctx),
);
