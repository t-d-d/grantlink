import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  MODELS,
  ModelRefused,
  proposeReferences,
  type ModelId,
  type ModelResult,
} from "../src/extract/model.ts";
import { RULES_VERSION, type FundingSections } from "../src/extract/rules.ts";
import { FLOORS } from "./floors.ts";
import {
  goldA,
  goldA2,
  goldB,
  goldB2,
  manifest,
  paperFile,
  pinned as pin,
  snapshotKeys,
} from "./gold.ts";
import {
  makeReport,
  readAlone,
  RULES_ALONE,
  verdict,
  type GoldA2Scores,
  type GoldB2Scores,
  type Report,
} from "./report.ts";
import {
  score,
  type GoldA,
  type GoldB,
  type ModelPass,
  type Scores,
} from "./score.ts";

// The eval runner. It reads the snapshot from a directory laid out as the
// bucket is, and calls nothing outside the repo but the model, through the
// model module: the workflow downloads the snapshot and files the report in
// its own steps (docs/constraints/evals.md). Run
//
//   node evals/run.ts <snapshot-dir> [<report.json>]
//
// to print the scores, and with a second path to write a report. A report
// needs FINGERPRINT, COMMIT and RUN_URL, which only CI sets. It prints
// paper ids and scores, never text.
//
// It scores the rules alone, then the rules and each model in MODELS on the
// same papers, and each model alone from the same replies, and needs
// OPENROUTER_KEY whenever a gold paper is scored. In CI that is the eval
// environment's secret. In a session the proxy puts the key in, so any
// value will do, and NODE_USE_ENV_PROXY=1 sends the calls through it.

// How many papers each model reads at once.
const AT_ONCE = 8;

const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

export function loadSnapshot(
  dir: string,
  pin: { id: string; manifestSha256: string | null },
): Map<string, FundingSections> {
  const texts = new Map<string, FundingSections>();
  if (pin.manifestSha256 === null) return texts;
  const raw = readFileSync(join(dir, snapshotKeys.manifest(pin.id)));
  if (sha256(raw) !== pin.manifestSha256) {
    throw new Error(
      `the manifest of snapshot ${pin.id} does not match its pin`,
    );
  }
  const { papers } = manifest.parse(JSON.parse(raw.toString("utf8")));
  for (const entry of papers) {
    const body = readFileSync(
      join(dir, snapshotKeys.paper(pin.id, entry.pmcid)),
    );
    if (sha256(body) !== entry.sha256) {
      throw new Error(`the text of ${entry.pmcid} does not match the manifest`);
    }
    const { pmcid, ...sections } = paperFile.parse(
      JSON.parse(body.toString("utf8")),
    );
    if (pmcid !== entry.pmcid) {
      throw new Error(`the file for ${entry.pmcid} holds another paper`);
    }
    texts.set(pmcid, sections);
  }
  return texts;
}

type Rows = Report["rows"];

const asRows = (scores: Scores): Rows =>
  FLOORS.map((floor) => ({ id: floor.id, ...scores.rows[floor.id] }));

// Asks one model for one paper's references, from its funding text only.
export type Propose = (
  model: ModelId,
  text: readonly string[],
) => Promise<ModelResult>;

export interface Candidate {
  modelId: ModelId;
  rows: Rows;
  // The same rows for the model alone, from the same replies.
  alone: Rows;
  // Papers whose reply could not be read after one retry. Ids only.
  unprocessed: string[];
  // How many gold papers of each set the model read, so its scores alone
  // are over these and leave the rest out (#696).
  read: { goldA: number; goldB: number };
}

// Runs fn over every item, at most `limit` at a time, keeping their order.
async function inTurn<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

// Each gold paper's id, once, in order.
const goldIds = (a: readonly GoldA[], b: readonly GoldB[]): string[] => [
  ...new Set([...a.map((p) => p.pmcid), ...b.map((p) => p.pmcid)]),
];

async function modelPass(
  model: ModelId,
  pmcids: readonly string[],
  texts: ReadonlyMap<string, FundingSections>,
  propose: Propose,
): Promise<ModelPass & { unprocessed: string[] }> {
  const results = await inTurn(pmcids, AT_ONCE, (pmcid) => {
    const sections = texts.get(pmcid);
    if (sections === undefined) {
      throw new Error(
        `no text in the snapshot for ${pmcid}: a new gold paper needs a new snapshot id`,
      );
    }
    return propose(model, sections.text);
  });
  const found = new Map<string, string[]>();
  const unprocessed: string[] = [];
  let spend = 0;
  results.forEach((result, i) => {
    const pmcid = pmcids[i] ?? "";
    spend += result.spend;
    if (result.status === "unprocessed") unprocessed.push(pmcid);
    else
      found.set(
        pmcid,
        result.references.map((r) => r.normalised),
      );
  });
  return { found, spend, unprocessed };
}

const scoreOf = (rows: Rows, id: string): number | null =>
  rows.find((row) => row.id === id)?.score ?? null;

// Gold set A2's recall, scored as gold set A's is, with its misses dropped
// so no report holds them (#695).
function recallA2(
  texts: ReadonlyMap<string, FundingSections>,
  papers: readonly GoldA[],
  model?: ModelPass,
  rules = true,
): GoldA2Scores["rules"] {
  const { rows } = score({
    texts,
    goldA: papers,
    goldB: [],
    rules,
    ...(model === undefined ? {} : { model }),
  });
  return rows["recall-a"];
}

// Gold set B2's precision and recall, scored as gold set B's are, with
// nothing beside them that names a paper (#695).
function scoresB2(
  texts: ReadonlyMap<string, FundingSections>,
  papers: readonly GoldB[],
  model?: ModelPass,
  rules = true,
): GoldB2Scores["rules"] {
  const { rows } = score({
    texts,
    goldA: [],
    goldB: papers,
    rules,
    ...(model === undefined ? {} : { model }),
  });
  return { precision: rows["precision-b"], recall: rows["recall-b"] };
}

// A row's n, how many gold papers its score is over.
const nOf = (rows: Rows, id: string): number =>
  rows.find((row) => row.id === id)?.n ?? 0;

export async function evaluate(input: {
  texts: ReadonlyMap<string, FundingSections>;
  goldA: readonly GoldA[];
  goldB: readonly GoldB[];
  // Held out, and scored apart from the gating rows (#695).
  goldA2?: readonly GoldA[];
  goldB2?: readonly GoldB[];
  models: readonly ModelId[];
  propose: Propose;
}): Promise<{
  rows: Rows;
  baseline: Rows;
  candidates: Candidate[];
  missedA: string[];
  goldA2: GoldA2Scores;
  goldB2: GoldB2Scores;
}> {
  const heldOut = input.goldA2 ?? [];
  const heldOutB = input.goldB2 ?? [];
  // Rules ship alone (#330), so the release and the baseline are the same
  // run.
  const release = score(input);
  const baseline = asRows(release);
  const pmcids = goldIds(input.goldA, input.goldB);
  const candidates: Candidate[] = [];
  const goldA2Models: GoldA2Scores["models"] = [];
  const goldB2Models: GoldB2Scores["models"] = [];
  for (const model of input.models) {
    const pass = await modelPass(model, pmcids, input.texts, input.propose);
    // Gold set A2's papers go to the model in a pass of their own, so the
    // spend row stays over gold sets A and B, as its floor was set. A paper
    // whose reply could not be read is out of the model's recall alone and
    // scores what the rules found after the rules (#696). Only how many
    // there were is reported.
    const passA2 = await modelPass(
      model,
      heldOut.map((paper) => paper.pmcid),
      input.texts,
      input.propose,
    );
    const aloneA2 = recallA2(input.texts, heldOut, passA2, false);
    goldA2Models.push({
      modelId: model,
      alone: aloneA2,
      rulesThen: recallA2(input.texts, heldOut, passA2),
      unprocessed: passA2.unprocessed.length,
      read: aloneA2.n,
    });
    // Gold set B2's papers go in a pass of their own too, for the same
    // reason.
    const passB2 = await modelPass(
      model,
      heldOutB.map((paper) => paper.pmcid),
      input.texts,
      input.propose,
    );
    const aloneB2 = scoresB2(input.texts, heldOutB, passB2, false);
    goldB2Models.push({
      modelId: model,
      alone: aloneB2,
      rulesThen: scoresB2(input.texts, heldOutB, passB2),
      unprocessed: passB2.unprocessed.length,
      read: aloneB2.recall.n,
    });
    const rows = asRows(score({ ...input, model: pass }));
    // What the model adds is its recall on gold set B over the rules'.
    const withModel = scoreOf(rows, "recall-b");
    const rulesAlone = scoreOf(baseline, "recall-b");
    const adds =
      withModel === null || rulesAlone === null
        ? null
        : Math.max(0, withModel - rulesAlone);
    // The model alone, scored from the same replies, so it costs no second
    // call (#694). A paper it left unread is out of these rows (#696).
    const alone = asRows(score({ ...input, model: pass, rules: false }));
    candidates.push({
      modelId: model,
      rows: rows.map((row) =>
        row.id === "model-adds" ? { ...row, score: adds } : row,
      ),
      alone,
      unprocessed: pass.unprocessed,
      read: { goldA: nOf(alone, "recall-a"), goldB: nOf(alone, "recall-b") },
    });
  }
  return {
    rows: baseline,
    baseline,
    candidates,
    missedA: release.missedA,
    goldA2: {
      rules: recallA2(input.texts, heldOut),
      models: goldA2Models,
    },
    goldB2: {
      rules: scoresB2(input.texts, heldOutB),
      models: goldB2Models,
    },
  };
}

// The gold papers to score. A snapshot not yet pinned scores nothing: a
// pull request that adds labels names a new snapshot with no pin, its rows
// wait rather than block, and once it deploys a run takes the snapshot and
// a later pull request pins it. Unpinning shows in review, in
// evals/snapshot.json.
export function goldToScore(
  pin: { manifestSha256: string | null },
  a: readonly GoldA[],
  b: readonly GoldB[],
  a2: readonly GoldA[],
  b2: readonly GoldB[],
): {
  goldA: readonly GoldA[];
  goldB: readonly GoldB[];
  goldA2: readonly GoldA[];
  goldB2: readonly GoldB[];
} {
  return pin.manifestSha256 === null
    ? { goldA: [], goldB: [], goldA2: [], goldB2: [] }
    : { goldA: a, goldB: b, goldA2: a2, goldB2: b2 };
}

// With no private bucket there is no snapshot to read, though one is
// pinned: after a deleted stack, until the owner copies it back after the
// deploy that makes the bucket again (#253). The workflow then sets
// NO_BUCKET to true, and the runner scores as before a snapshot is pinned,
// so the eval does not stop that deploy.
const noBucketEnv = z
  .enum(["true", "false"], { error: "NO_BUCKET must be true or false" })
  .optional()
  .transform((value) => value === "true");

const ciEnv = z.object({
  FINGERPRINT: z.string().min(1),
  COMMIT: z.string().min(1),
  RUN_URL: z.string().min(1),
});

// Asks again, up to three tries in all, when OpenRouter is busy or fails
// on its side, so one passing refusal among hundreds of calls does not stop
// the eval. Any other refusal, such as a bad key or no credit left, fails
// at once, and so does an outage that outlasts the tries.
const TRIES = 3;
const passing = (error: unknown): boolean =>
  error instanceof ModelRefused &&
  (error.status === 429 || error.status >= 500);

export function retrying(
  propose: Propose,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Propose {
  return async (model, text) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await propose(model, text);
      } catch (error) {
        if (attempt >= TRIES || !passing(error)) throw error;
        await wait(5_000 * 2 ** (attempt - 1));
      }
    }
  };
}

// Calls the model through the model module, with the key from the
// environment. The key is read only when a paper is sent.
const openRouter: Propose = (model, text) => {
  const key = process.env.OPENROUTER_KEY;
  if (key === undefined || key === "") {
    return Promise.reject(
      new Error("OPENROUTER_KEY is not set, so no model can be scored"),
    );
  }
  return proposeReferences(text, { model, key });
};

async function main(dir: string, out: string | undefined): Promise<void> {
  const pinned = noBucketEnv.parse(process.env.NO_BUCKET)
    ? { ...pin, manifestSha256: null }
    : pin;
  const texts = loadSnapshot(dir, pinned);
  const result = await evaluate({
    texts,
    ...goldToScore(
      pinned,
      goldA.papers,
      goldB.papers,
      goldA2.papers,
      goldB2.papers,
    ),
    models: MODELS,
    propose: retrying(openRouter),
  });
  const meta = out === undefined ? undefined : ciEnv.parse(process.env);
  const report = makeReport({
    fingerprint: meta?.FINGERPRINT ?? "0".repeat(64),
    commit: meta?.COMMIT ?? "0".repeat(40),
    runUrl:
      meta?.RUN_URL ?? "https://github.com/t-d-d/grantlink/actions/runs/0",
    modelId: RULES_ALONE,
    rulesVersion: RULES_VERSION,
    snapshot:
      pinned.manifestSha256 === null
        ? null
        : { id: pinned.id, manifestSha256: pinned.manifestSha256 },
    createdAt: new Date().toISOString(),
    ...result,
  });
  for (const row of verdict(report).rows) {
    const shown = row.score === null ? "-" : row.score.toFixed(4);
    console.log(`${row.id}\t${shown}\tn=${String(row.n)}\t${row.result}`);
  }
  if (result.missedA.length > 0) {
    console.log(`missed in gold set A: ${result.missedA.join(" ")}`);
  }
  // Held out: its recall, and never the ids of what it missed (#695).
  const held = (label: string, row: GoldA2Scores["rules"]) => {
    const shown = row.score === null ? "-" : row.score.toFixed(4);
    console.log(`${label}\trecall-a2\t${shown}\tn=${String(row.n)}`);
  };
  held("rules alone", result.goldA2.rules);
  for (const model of result.goldA2.models) {
    held(`${model.modelId} alone`, model.alone);
    held(`rules then ${model.modelId}`, model.rulesThen);
    if (model.unprocessed > 0) {
      console.log(
        `${model.modelId} left ${String(model.unprocessed)} gold set A2 papers unread`,
      );
    }
  }
  // Held out: its precision and recall, and never the ids of what it
  // missed (#695).
  const heldB = (label: string, both: GoldB2Scores["rules"]) => {
    for (const [id, row] of [
      ["precision-b2", both.precision],
      ["recall-b2", both.recall],
    ] as const) {
      const shown = row.score === null ? "-" : row.score.toFixed(4);
      console.log(`${label}\t${id}\t${shown}\tn=${String(row.n)}`);
    }
  };
  heldB("rules alone", result.goldB2.rules);
  for (const model of result.goldB2.models) {
    heldB(`${model.modelId} alone`, model.alone);
    heldB(`rules then ${model.modelId}`, model.rulesThen);
    if (model.unprocessed > 0) {
      console.log(
        `${model.modelId} left ${String(model.unprocessed)} gold set B2 ${model.unprocessed === 1 ? "paper" : "papers"} unread`,
      );
    }
  }
  for (const candidate of result.candidates) {
    for (const [label, rows] of [
      [candidate.modelId, candidate.rows],
      [`${candidate.modelId} alone`, candidate.alone],
    ] as const) {
      for (const row of rows) {
        const shown = row.score === null ? "-" : row.score.toFixed(4);
        console.log(`${label}\t${row.id}\t${shown}\tn=${String(row.n)}`);
      }
    }
    if (candidate.unprocessed.length > 0) {
      console.log(
        `${candidate.modelId} left for the next run: ${candidate.unprocessed.join(" ")}`,
      );
    }
  }
  for (const line of readAlone(report)) console.log(line);
  if (out !== undefined) writeFileSync(out, `${JSON.stringify(report)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (dir === undefined) {
    throw new Error("usage: node evals/run.ts <snapshot-dir> [<report.json>]");
  }
  await main(dir, out);
}
