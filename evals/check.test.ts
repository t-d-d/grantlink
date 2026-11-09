import { describe, expect, it } from "vitest";
import { comment, gate, noLive, readLive } from "./check.ts";
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

  it("says the live release is not known when its record cannot be read", () => {
    const text = comment(report({ spend: 0 }), "page-unread");
    expect(text).toContain(
      "The release record on the live page could not be read",
    );
    expect(text).not.toMatch(/no live release|no release is live|no deploy/iu);
  });

  // #139: the report comes from the release record, so there is no
  // fingerprint to work out and no report to look up.
  it.each([
    "unknown-commit",
    "predates-eval",
    "fingerprint-failed",
    "no-report",
  ])("no longer knows %s", (reason) => {
    expect(() => noLive.parse(reason)).toThrow();
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
