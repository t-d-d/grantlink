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
