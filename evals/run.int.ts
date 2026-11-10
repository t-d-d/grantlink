import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ModelRefused,
  type ModelId,
  type ModelResult,
} from "../src/extract/model.ts";
import {
  evaluate,
  goldToScore,
  loadSnapshot,
  retrying,
  type Propose,
} from "./run.ts";

// The runner against a snapshot written to a directory, laid out as the
// bucket is.
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function snapshotDir(
  papers: Record<string, string[]>,
  setB: readonly string[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), "grantlink-eval-"));
  mkdirSync(join(dir, "eval/s1/papers"), { recursive: true });
  const entries = Object.entries(papers).map(([pmcid, text]) => {
    const body = JSON.stringify({ pmcid, text, awards: [] });
    writeFileSync(join(dir, `eval/s1/papers/${pmcid}.json`), body);
    return setB.includes(pmcid)
      ? { pmcid, set: "B", sha256: sha(body), grants: [] }
      : { pmcid, set: "A", sha256: sha(body), grants: ["A11111"] };
  });
  const manifest = JSON.stringify({
    id: "s1",
    createdAt: "2026-11-09T12:00:00.000Z",
    goldA: { query: "q", seed: 1, size: 2 },
    papers: entries,
  });
  writeFileSync(join(dir, "eval/s1/manifest.json"), manifest);
  return { dir, manifestSha256: sha(manifest) };
}

const papers = {
  PMC1: ["Funded by Cancer Research UK grant A11111."],
  PMC2: ["Funded by Cancer Research UK."],
};

describe("the eval runner", () => {
  it("reads a snapshot whose manifest matches the pin", () => {
    const { dir, manifestSha256 } = snapshotDir(papers);
    const texts = loadSnapshot(dir, { id: "s1", manifestSha256 });
    expect([...texts.keys()]).toEqual(["PMC1", "PMC2"]);
    expect(texts.get("PMC1")?.text).toEqual(papers.PMC1);
  });

  it("refuses a manifest that does not match the pin", () => {
    const { dir } = snapshotDir(papers);
    expect(() =>
      loadSnapshot(dir, { id: "s1", manifestSha256: "0".repeat(64) }),
    ).toThrow(/manifest/u);
  });

  it("refuses a paper whose text does not match the manifest", () => {
    const { dir, manifestSha256 } = snapshotDir(papers);
    writeFileSync(
      join(dir, "eval/s1/papers/PMC2.json"),
      JSON.stringify({ pmcid: "PMC2", text: ["changed"], awards: [] }),
    );
    expect(() => loadSnapshot(dir, { id: "s1", manifestSha256 })).toThrow(
      /PMC2/u,
    );
    // The error names the paper, never its text.
    try {
      loadSnapshot(dir, { id: "s1", manifestSha256 });
    } catch (error) {
      expect(String(error)).not.toContain("changed");
    }
  });

  it("reads nothing before a snapshot is pinned", () => {
    expect(
      loadSnapshot("/nowhere", { id: "s1", manifestSha256: null }).size,
    ).toBe(0);
  });

  it("scores the release and the rules-only baseline", async () => {
    const { dir, manifestSha256 } = snapshotDir(papers);
    const texts = loadSnapshot(dir, { id: "s1", manifestSha256 });
    const result = await evaluate({
      texts,
      goldA: [
        { pmcid: "PMC1", grants: ["A11111"] },
        { pmcid: "PMC2", grants: ["A22222"] },
      ],
      goldB: [],
      models: [],
      propose: () => Promise.reject(new Error("no model")),
    });
    const recall = (rows: typeof result.rows) =>
      rows.find((row) => row.id === "recall-a")?.score;
    expect(recall(result.rows)).toBe(0.5);
    expect(recall(result.baseline)).toBe(0.5);
    expect(result.missedA).toEqual(["PMC2"]);
    // The manifest was read from disk, and nothing was written there.
    expect(readFileSync(join(dir, "eval/s1/manifest.json"), "utf8")).toContain(
      "PMC1",
    );
  });
});

// The snapshot keeps a gold set B paper with no funding text or awards,
// so its label, of no references, scores what the rules find in it (#399).
describe("a gold set B paper with empty funding sections", () => {
  it("is read from the snapshot and scored", async () => {
    const { dir, manifestSha256 } = snapshotDir({ PMC4: [] }, ["PMC4"]);
    const texts = loadSnapshot(dir, { id: "s1", manifestSha256 });
    expect(texts.get("PMC4")).toEqual({ text: [], awards: [] });
    const result = await evaluate({
      texts,
      goldA: [],
      goldB: [{ pmcid: "PMC4", references: [] }],
      models: [],
      propose: () => Promise.reject(new Error("no model")),
    });
    const row = (id: string) => result.rows.find((r) => r.id === id);
    expect(row("precision-b")).toMatchObject({ score: 1, n: 1 });
    expect(row("recall-b")).toMatchObject({ score: 1, n: 1 });
  });
});

describe("which gold papers are scored", () => {
  const a = [{ pmcid: "PMC1", grants: ["A11111"] }];
  const b = [{ pmcid: "PMC2", references: [] }];

  it("scores both gold sets against a pinned snapshot", () => {
    expect(goldToScore({ manifestSha256: "a".repeat(64) }, a, b)).toEqual({
      goldA: a,
      goldB: b,
    });
  });

  it("scores nothing while a new snapshot waits to be taken and pinned", () => {
    // A labels pull request names a new snapshot with no pin yet. Its rows
    // wait rather than block, so it can merge, deploy and be taken.
    expect(goldToScore({ manifestSha256: null }, a, b)).toEqual({
      goldA: [],
      goldB: [],
    });
  });
});

describe("the rules, then each model", () => {
  const texts = new Map([
    ["PMC1", { text: papers.PMC1, awards: [] }],
    ["PMC2", { text: papers.PMC2, awards: [] }],
    ["PMC3", { text: ["Funded by Cancer Research UK, ref 4 4."], awards: [] }],
  ]);
  const models = [
    "anthropic/claude-haiku-5.5",
    "anthropic/claude-sonnet-5.5",
  ] as ModelId[];
  // Haiku finds PMC3's reference. Sonnet finds it too, but cannot read PMC2.
  const replies: Record<string, Record<string, ModelResult>> = {
    "anthropic/claude-haiku-5.5": {
      PMC1: { status: "read", references: [], rejected: 0, spend: 0.001 },
      PMC2: { status: "read", references: [], rejected: 0, spend: 0.001 },
      PMC3: {
        status: "read",
        references: [{ asWritten: "4 4", normalised: "44", confidence: 0.7 }],
        rejected: 1,
        spend: 0.001,
      },
    },
    "anthropic/claude-sonnet-5.5": {
      PMC1: { status: "read", references: [], rejected: 0, spend: 0.01 },
      PMC2: { status: "unprocessed", spend: 0.02 },
      PMC3: {
        status: "read",
        references: [{ asWritten: "4 4", normalised: "44", confidence: 0.9 }],
        rejected: 0,
        spend: 0.01,
      },
    },
  };
  const sent: { model: string; text: readonly string[] }[] = [];
  const propose: Propose = (model, text) => {
    sent.push({ model, text });
    const pmcid = [...texts].find(([, s]) => s.text === text)?.[0] ?? "";
    const result = replies[model]?.[pmcid];
    return result === undefined
      ? Promise.reject(new Error(`no reply for ${pmcid}`))
      : Promise.resolve(result);
  };

  it("scores the rules alone and the rules with each model, with each one's spend", async () => {
    sent.length = 0;
    const result = await evaluate({
      texts,
      goldA: [{ pmcid: "PMC1", grants: ["A11111"] }],
      goldB: [
        { pmcid: "PMC2", references: [] },
        { pmcid: "PMC3", references: ["44"] },
      ],
      models,
      propose,
    });
    const row = (rows: typeof result.rows, id: string) =>
      rows.find((r) => r.id === id)?.score;
    // The release is the rules alone, as #330 decided.
    expect(row(result.rows, "recall-b")).toBe(0);
    expect(row(result.baseline, "recall-b")).toBe(0);
    expect(row(result.baseline, "spend")).toBe(0);
    expect(result.candidates.map((c) => c.modelId)).toEqual(models);
    const [haiku, sonnet] = result.candidates;
    expect(row(haiku?.rows ?? [], "recall-b")).toBe(1);
    expect(row(haiku?.rows ?? [], "model-adds")).toBe(1);
    expect(row(haiku?.rows ?? [], "recall-a")).toBe(1);
    // $0.003 over 3 papers is $1 per 1,000.
    expect(row(haiku?.rows ?? [], "spend")).toBeCloseTo(1);
    expect(haiku?.unprocessed).toEqual([]);
    expect(row(sonnet?.rows ?? [], "spend")).toBeCloseTo(40 / 3);
    expect(sonnet?.unprocessed).toEqual(["PMC2"]);
    // Each model reads each gold paper's funding text, once.
    expect(sent).toHaveLength(6);
  });

  it("calls no model when no gold paper is scored", async () => {
    sent.length = 0;
    const result = await evaluate({
      texts,
      goldA: [],
      goldB: [],
      models,
      propose,
    });
    expect(sent).toHaveLength(0);
    for (const candidate of result.candidates) {
      expect(candidate.rows.every((r) => r.score === null)).toBe(true);
    }
  });
});

describe("a refusal that passes", () => {
  const read: ModelResult = {
    status: "read",
    references: [],
    rejected: 0,
    spend: 0,
  };
  const model = "anthropic/claude-haiku-5.5" as ModelId;
  const failing = (...errors: Error[]) => {
    let calls = 0;
    const propose: Propose = () => {
      calls += 1;
      const error = errors.shift();
      return error === undefined
        ? Promise.resolve(read)
        : Promise.reject(error);
    };
    return { propose, calls: () => calls };
  };
  const noWait = () => Promise.resolve();

  it.each([429, 500, 502, 503])(
    "asks again after a %i, and takes the answer",
    async (status) => {
      const { propose, calls } = failing(
        new ModelRefused(status),
        new ModelRefused(status),
      );
      await expect(retrying(propose, noWait)(model, ["t"])).resolves.toEqual(
        read,
      );
      expect(calls()).toBe(3);
    },
  );

  it("stops after three tries, so a long outage fails the eval", async () => {
    const { propose, calls } = failing(
      new ModelRefused(503),
      new ModelRefused(503),
      new ModelRefused(503),
    );
    await expect(retrying(propose, noWait)(model, ["t"])).rejects.toThrow(
      ModelRefused,
    );
    expect(calls()).toBe(3);
  });

  it.each([400, 401, 402, 403])(
    "fails at once on a %i, such as a bad key or no credit",
    async (status) => {
      const { propose, calls } = failing(new ModelRefused(status));
      await expect(retrying(propose, noWait)(model, ["t"])).rejects.toThrow(
        ModelRefused,
      );
      expect(calls()).toBe(1);
    },
  );

  it("waits longer before each try", async () => {
    const waits: number[] = [];
    const { propose } = failing(new ModelRefused(429), new ModelRefused(429));
    await retrying(propose, (ms) => {
      waits.push(ms);
      return Promise.resolve();
    })(model, ["t"]);
    expect(waits).toHaveLength(2);
    expect(waits[1]).toBeGreaterThan(waits[0] ?? Infinity);
  });
});
