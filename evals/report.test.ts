import { describe, expect, it } from "vitest";
import { FLOORS } from "./floors.ts";
import { makeReport, report, verdict, type Report } from "./report.ts";

const rows = (scores: Partial<Record<string, number | null>> = {}) =>
  FLOORS.map((floor) => ({
    id: floor.id,
    score: floor.id in scores ? (scores[floor.id] ?? null) : null,
    n: 3,
  }));

const good: Report = {
  fingerprint: "a".repeat(64),
  commit: "b".repeat(40),
  runUrl: "https://github.com/t-d-d/grantlink/actions/runs/123",
  modelId: "none: rules only",
  rulesVersion: "rules-1",
  snapshot: { id: "s1", manifestSha256: "c".repeat(64) },
  createdAt: "2026-11-09T12:00:00.000Z",
  rows: rows({ "recall-a": 0.97, spend: 0 }),
  baseline: rows({ "recall-a": 0.97, spend: 0 }),
  missedA: ["PMC1"],
};

describe("fitness: every score names what produced it (evals.md)", () => {
  it("takes a report that names its fingerprint, its model and its run", () => {
    expect(makeReport(good)).toEqual(good);
  });

  it.each(["fingerprint", "modelId", "runUrl"] as const)(
    "refuses a report without its %s",
    (field) => {
      const rest = Object.fromEntries(
        Object.entries(good).filter(([key]) => key !== field),
      );
      expect(() => makeReport(rest as Report)).toThrow();
      expect(() => makeReport({ ...good, [field]: "" })).toThrow();
    },
  );

  it("refuses a run URL that is not a GitHub Actions run", () => {
    expect(() =>
      makeReport({ ...good, runUrl: "https://example.com/runs/1" }),
    ).toThrow();
  });

  it("refuses a field it does not know, so no text rides along", () => {
    expect(() =>
      report.parse({ ...good, text: "Funded by Cancer Research UK" }),
    ).toThrow();
  });

  it("takes the scores of each candidate model, with the papers each left", () => {
    const withModels: Report = {
      ...good,
      candidates: [
        {
          modelId: "anthropic/claude-haiku-5.5",
          rows: rows({ "recall-a": 0.98, spend: 0.4 }),
          unprocessed: ["PMC2"],
        },
      ],
    };
    expect(makeReport(withModels)).toEqual(withModels);
  });

  it("takes each candidate's rows for the model alone", () => {
    const withAlone: Report = {
      ...good,
      candidates: [
        {
          modelId: "anthropic/claude-haiku-5.5",
          rows: rows({ "recall-b": 0.96, spend: 0.4 }),
          alone: rows({ "recall-b": 0.92, spend: 0.4 }),
          unprocessed: [],
        },
      ],
    };
    expect(makeReport(withAlone)).toEqual(withAlone);
    expect(() =>
      makeReport({
        ...withAlone,
        candidates: [
          {
            modelId: "anthropic/claude-haiku-5.5",
            rows: rows(),
            alone: rows().slice(1),
            unprocessed: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("takes a candidate filed before the eval scored a model alone", () => {
    const candidate = {
      modelId: "anthropic/claude-haiku-5.5",
      rows: rows({ spend: 0.4 }),
      unprocessed: [],
    };
    const parsed = makeReport({ ...good, candidates: [candidate] });
    expect(parsed.candidates?.[0]?.alone).toBeUndefined();
  });

  it("takes how many papers each model read alone (#696)", () => {
    const withRead: Report = {
      ...good,
      candidates: [
        {
          modelId: "anthropic/claude-sonnet-5.5",
          rows: rows({ "recall-b": 0.96, spend: 0.4 }),
          alone: rows({ "recall-b": 0.92, spend: 0.4 }),
          unprocessed: ["PMC2"],
          read: { goldA: 3, goldB: 2 },
        },
      ],
      goldA2: {
        rules: { score: 0.9, n: 300 },
        models: [
          {
            modelId: "anthropic/claude-sonnet-5.5",
            alone: { score: 0.8, n: 297 },
            rulesThen: { score: 0.95, n: 300 },
            unprocessed: 3,
            read: 297,
          },
        ],
      },
    };
    expect(makeReport(withRead)).toEqual(withRead);
  });

  it("takes a report filed before the eval said how many papers each model read alone (#696)", () => {
    const parsed = makeReport({
      ...good,
      candidates: [
        {
          modelId: "anthropic/claude-sonnet-5.5",
          rows: rows({ spend: 0.4 }),
          alone: rows({ spend: 0.4 }),
          unprocessed: ["PMC2"],
        },
      ],
      goldA2: {
        rules: { score: 0.9, n: 300 },
        models: [
          {
            modelId: "anthropic/claude-sonnet-5.5",
            alone: { score: 0.8, n: 300 },
            rulesThen: { score: 0.95, n: 300 },
            unprocessed: 3,
          },
        ],
      },
    });
    expect(parsed.candidates?.[0]?.read).toBeUndefined();
    expect(parsed.goldA2?.models[0]?.read).toBeUndefined();
  });

  it("takes a report filed before the eval scored any model", () => {
    expect(makeReport(good).candidates).toBeUndefined();
  });

  it("refuses a candidate without its model or with a row left out", () => {
    const candidate = {
      modelId: "anthropic/claude-haiku-5.5",
      rows: rows(),
      unprocessed: [],
    };
    expect(() =>
      makeReport({ ...good, candidates: [{ ...candidate, modelId: "" }] }),
    ).toThrow();
    expect(() =>
      makeReport({
        ...good,
        candidates: [{ ...candidate, rows: candidate.rows.slice(1) }],
      }),
    ).toThrow();
  });

  it("refuses a report that leaves out a row", () => {
    expect(() => makeReport({ ...good, rows: good.rows.slice(1) })).toThrow();
  });
});

describe("the verdict on a report", () => {
  it("passes a report whose gating rows all clear, or have no data yet", () => {
    const result = verdict(good);
    expect(result.releasable).toBe(true);
    expect(result.rows.map((row) => [row.id, row.result])).toEqual([
      ["precision-b", "awaiting snapshot"],
      ["recall-b", "awaiting snapshot"],
      ["review-share", "not measured yet"],
      ["recall-a", "go"],
      ["model-adds", "not measured yet"],
      ["spend", "go"],
    ]);
  });

  it("stops a report below any gating floor", () => {
    const below = { ...good, rows: rows({ "recall-a": 0.9, spend: 0 }) };
    expect(verdict(below).releasable).toBe(false);
    const dear = { ...good, rows: rows({ "recall-a": 0.99, spend: 6 }) };
    expect(verdict(dear).releasable).toBe(false);
  });

  it("does not stop a report on a row that is only reported", () => {
    const busy = {
      ...good,
      rows: rows({ "recall-a": 0.99, spend: 0, "review-share": 0.5 }),
    };
    expect(verdict(busy).releasable).toBe(true);
  });
});

describe("fitness: a report gives gold set A2's recall and no ids of what it missed (evals.md)", () => {
  const goldA2 = {
    rules: { score: 0.9, n: 300 },
    models: [
      {
        modelId: "anthropic/claude-haiku-5.5",
        alone: { score: 0.8, n: 300 },
        rulesThen: { score: 0.95, n: 300 },
        unprocessed: 2,
      },
    ],
  };

  it("takes gold set A2's recall for the rules alone, each model alone, and the rules then each model", () => {
    const withA2: Report = { ...good, goldA2 };
    expect(makeReport(withA2)).toEqual(withA2);
  });

  it("takes a report filed before gold set A2 joined the eval", () => {
    expect(makeReport(good).goldA2).toBeUndefined();
  });

  it("refuses ids beside gold set A2's scores", () => {
    expect(() =>
      report.parse({ ...good, goldA2: { ...goldA2, missed: ["PMC1"] } }),
    ).toThrow();
    expect(() =>
      report.parse({
        ...good,
        goldA2: { ...goldA2, rules: { ...goldA2.rules, missed: ["PMC1"] } },
      }),
    ).toThrow();
    expect(() =>
      report.parse({
        ...good,
        goldA2: {
          ...goldA2,
          models: [{ ...goldA2.models[0], missed: ["PMC1"] }],
        },
      }),
    ).toThrow();
  });
});

describe("fitness: a report gives gold set B2's scores and no ids of what it missed (evals.md)", () => {
  const both = (precision: number, recall: number, n = 100) => ({
    precision: { score: precision, n },
    recall: { score: recall, n },
  });
  const goldB2 = {
    rules: both(0.97, 0.88),
    models: [
      {
        modelId: "anthropic/claude-haiku-5.5",
        alone: both(0.9, 0.85, 99),
        rulesThen: both(0.95, 0.92),
        unprocessed: 1,
        read: 99,
      },
    ],
  };

  it("takes gold set B2's precision and recall for the rules alone, each model alone, and the rules then each model", () => {
    const withB2: Report = { ...good, goldB2 };
    expect(makeReport(withB2)).toEqual(withB2);
  });

  it("takes a report filed before gold set B2 joined the eval", () => {
    expect(makeReport(good).goldB2).toBeUndefined();
  });

  it("refuses ids beside gold set B2's scores", () => {
    expect(() =>
      report.parse({ ...good, goldB2: { ...goldB2, missed: ["PMC1"] } }),
    ).toThrow();
    expect(() =>
      report.parse({
        ...good,
        goldB2: {
          ...goldB2,
          rules: {
            ...goldB2.rules,
            recall: { ...goldB2.rules.recall, missed: ["PMC1"] },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      report.parse({
        ...good,
        goldB2: {
          ...goldB2,
          models: [{ ...goldB2.models[0], unprocessed: ["PMC1"] }],
        },
      }),
    ).toThrow();
  });
});
