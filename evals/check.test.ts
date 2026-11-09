import { describe, expect, it } from "vitest";
import { comment, commentFrom, gate, noLive, readLive } from "./check.ts";
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

  it("says when main has not been deployed yet", () => {
    const text = comment(report({ spend: 0 }), "no-deploy");
    expect(text).toContain("No deploy of main has run yet");
    // The live release is read from the page now, not from deploy.yml's
    // newest runs (#85).
    expect(text).not.toContain("recent runs");
  });

  it.each([
    ["predates-eval", "The live release predates the eval's inputs"],
    ["no-report", "The live release has no report filed"],
    [
      "unknown-commit",
      "The live release's commit is not in this repository's history",
    ],
    ["page-unread", "The release record on the live page could not be read"],
    [
      "fingerprint-failed",
      "The live release's fingerprint could not be worked out",
    ],
  ] as const)(
    "says why a live release has nothing to compare with (%s), without saying none is live",
    (reason, words) => {
      const text = comment(report({ spend: 0 }), reason);
      expect(text).toContain(words);
      expect(text).not.toMatch(
        /no live release|no release is live|no deploy/iu,
      );
    },
  );

  it("blames a failed fingerprint on the release only when an input is missing (#90)", () => {
    const text = comment(report({ spend: 0 }), "fingerprint-failed");
    expect(text).not.toContain("predates");
    expect(text).toContain("the eval job's log");
  });

  it("refuses a reason it does not know", () => {
    expect(() => noLive.parse("gone")).toThrow();
  });

  // #138: a pull request that adds a row or a field reads a live report
  // filed by older code. The comparison is advice, so the comment shows
  // CI's scores alone rather than failing the eval check.
  it.each([
    [
      "one row short",
      (live: Report) => ({ ...live, rows: live.rows.slice(0, -1) }),
    ],
    ["with an extra key", (live: Report) => ({ ...live, retired: true })],
  ])("shows CI's scores alone when the live report is %s", (_, change) => {
    const live = readLive(
      JSON.stringify(change(report({ "recall-a": 0.9, spend: 0 }))),
      () => undefined,
    );
    expect(live).toBe("older-format");
    const text = comment(report({ "recall-a": 0.96, spend: 0 }), live);
    expect(text).toContain(
      "| Recall | Gold set A | 95% or more | 96.0% | - | go |",
    );
    expect(text).toContain(
      "The live release's report is in a format this pull request's code cannot read",
    );
  });

  it("reads a live report this code can read", () => {
    const live = report({ spend: 0 });
    expect(readLive(JSON.stringify(live))).toEqual(live);
  });

  it("treats a live report that is not JSON as one it cannot read", () => {
    expect(readLive("{", () => undefined)).toBe("older-format");
  });

  // The comment shows only that the live report could not be read. The
  // job's log keeps why, as paths and codes and never values, so a report
  // that is broken rather than old can still be told apart.
  it("logs why it cannot read a live report, without its values", () => {
    const lines: string[] = [];
    const live = report({ spend: 0 });
    readLive(JSON.stringify({ ...live, retired: "a value" }), (line) => {
      lines.push(line);
    });
    readLive("{", (line) => {
      lines.push(line);
    });
    expect(lines.join("\n")).toContain("unrecognized_keys");
    expect(lines.join("\n")).toContain("not JSON");
    expect(lines.join("\n")).not.toContain("a value");
  });
});

// #154: the command line decides which report must parse. CI's own report
// must, or the eval check would post a comment for an invalid report of its
// own. The live one is only compared with, so it may fail.
describe("the comment command on files", () => {
  const ci = JSON.stringify(report({ "recall-a": 0.96, spend: 0 }));
  const quiet = () => undefined;

  it.each([
    ["is not JSON", "{"],
    ["is not a report", JSON.stringify({ rows: [] })],
  ])("fails when CI's report %s, even beside a good live one", (_, raw) => {
    expect(() =>
      commentFrom(raw, { live: JSON.stringify(report({ spend: 0 })) }, quiet),
    ).toThrow();
  });

  it("fails when CI's report does not parse and there is no live one", () => {
    expect(() => commentFrom("{", { noLive: "no-deploy" }, quiet)).toThrow();
  });

  it.each([
    ["is not JSON", "{"],
    ["is not a report", JSON.stringify({ rows: [] })],
  ])("prints a comment when only the live report %s", (_, raw) => {
    const text = commentFrom(ci, { live: raw }, quiet);
    expect(text).toContain("<!-- grantlink:eval -->");
    expect(text).toContain(
      "| Recall | Gold set A | 95% or more | 96.0% | - | go |",
    );
  });

  it("prints a comment beside a live report that parses", () => {
    const text = commentFrom(
      ci,
      { live: JSON.stringify(report({ "recall-a": 0.9, spend: 0 })) },
      quiet,
    );
    expect(text).toContain(
      "| Recall | Gold set A | 95% or more | 96.0% | 90.0% | go |",
    );
  });

  it("refuses a no-live reason it does not know", () => {
    expect(() => commentFrom(ci, { noLive: "gone" }, quiet)).toThrow();
    expect(() => commentFrom(ci, { noLive: undefined }, quiet)).toThrow();
  });
});
