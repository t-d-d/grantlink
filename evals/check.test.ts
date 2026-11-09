import { describe, expect, it } from "vitest";
import { comment, gate, noLive } from "./check.ts";
import { FLOORS } from "./floors.ts";
import type { Report } from "./report.ts";

const rows = (scores: Partial<Record<string, number>>) =>
  FLOORS.map((floor) => ({
    id: floor.id,
    score: scores[floor.id] ?? null,
    n: 300,
  }));

const report = (scores: Partial<Record<string, number>>): Report => ({
  fingerprint: "a".repeat(64),
  commit: "b".repeat(40),
  runUrl: "https://github.com/t-d-d/grantlink/actions/runs/123",
  modelId: "none: rules only",
  rulesVersion: "rules-1",
  snapshot: null,
  createdAt: "2026-11-09T12:00:00.000Z",
  rows: rows(scores),
  baseline: rows(scores),
  missedA: [],
});

describe("the gate on a report", () => {
  it("passes a report for this fingerprint at or above every floor", () => {
    const result = gate(
      JSON.stringify(report({ "recall-a": 0.96, spend: 0 })),
      "a".repeat(64),
    );
    expect(result.pass).toBe(true);
  });

  it("stops a report below a gating floor, and says which row", () => {
    const result = gate(
      JSON.stringify(report({ "recall-a": 0.5, spend: 0 })),
      "a".repeat(64),
    );
    expect(result.pass).toBe(false);
    expect(result.lines.join("\n")).toMatch(/recall-a.*no-go/u);
  });

  it("stops a report filed for another fingerprint", () => {
    const result = gate(JSON.stringify(report({ spend: 0 })), "c".repeat(64));
    expect(result.pass).toBe(false);
    expect(result.lines.join("\n")).toContain("another fingerprint");
  });

  it("stops anything that is not a report", () => {
    expect(() => gate("{}", "a".repeat(64))).toThrow();
  });
});

describe("the pull request's comment", () => {
  it("shows CI's scores beside the live release's, with the runs behind each", () => {
    const text = comment(report({ "recall-a": 0.96, spend: 0 }), {
      ...report({ "recall-a": 0.9, spend: 0 }),
      runUrl: "https://github.com/t-d-d/grantlink/actions/runs/99",
    });
    expect(text).toContain(
      "| Recall | Gold set A | 95% or more | 96.0% | 90.0% | go |",
    );
    expect(text).toContain("actions/runs/123");
    expect(text).toContain("actions/runs/99");
    expect(text).toContain("<!-- grantlink:eval -->");
  });

  it("says when there is no live release to compare with", () => {
    expect(comment(report({ spend: 0 }), "no-deploy")).toContain(
      "No release is live yet",
    );
  });

  it.each([
    ["predates-eval", "The live release predates the eval's inputs"],
    ["no-report", "The live release has no report filed"],
    [
      "unknown-commit",
      "The live release's commit is not in this repository's history",
    ],
    ["history-unread", "GitHub's deploy history could not be read"],
  ] as const)(
    "says why a live release has nothing to compare with (%s), without saying none is live",
    (reason, words) => {
      const text = comment(report({ spend: 0 }), reason);
      expect(text).toContain(words);
      expect(text).not.toContain("No release is live");
    },
  );

  it("refuses a reason it does not know", () => {
    expect(() => noLive.parse("gone")).toThrow();
  });
});
