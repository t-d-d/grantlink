import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
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

  // #138, #153: a pull request that adds a row or a field reads a live
  // report filed by older code. The comparison is advice, so the comment
  // keeps the live scores for the rows both reports share.
  it("keeps the live scores for the rows an older live report has", () => {
    const older = report({ "recall-a": 0.9, spend: 0 });
    const live = readLive(
      JSON.stringify({ ...older, rows: older.rows.slice(0, -1) }),
      () => undefined,
    );
    expect(live).not.toBe("older-format");
    if (live === "older-format") return;
    const text = comment(report({ "recall-a": 0.96, spend: 0.5 }), live);
    expect(text).toContain(
      "| Recall | Gold set A | 95% or more | 96.0% | 90.0% | go |",
    );
    const last = FLOORS[FLOORS.length - 1];
    if (last === undefined) throw new Error("no floors");
    expect(text).toMatch(
      new RegExp(
        `\\| ${last.measure} \\| ${last.on} \\|[^\\n]*\\| - \\| [^|]+ \\|$`,
        "mu",
      ),
    );
    expect(text).toContain("actions/runs/123");
  });

  it("matches the live rows by id, ignoring ones it does not know and keys it does not read", () => {
    const older = report({ "recall-a": 0.9, spend: 0 });
    const live = readLive(
      JSON.stringify({
        ...older,
        retired: true,
        rows: [
          { id: "gone", score: 0.1, n: 3 },
          ...[...older.rows].reverse().map((row) => ({ ...row, extra: 1 })),
        ],
      }),
      () => undefined,
    );
    expect(live).not.toBe("older-format");
    if (live === "older-format") return;
    const text = comment(report({ "recall-a": 0.96, spend: 0 }), live);
    expect(text).toContain(
      "| Recall | Gold set A | 95% or more | 96.0% | 90.0% | go |",
    );
    // The unknown row's score would show if rows were read by position.
    expect(text).not.toContain("10.0%");
  });

  it.each([
    ["without rows", (live: Report) => ({ ...live, rows: "none" })],
    ["with no rows", (live: Report) => ({ ...live, rows: [] })],
    [
      "with no row this code knows",
      (live: Report) => ({ ...live, rows: [{ id: "gone", score: 0.1, n: 3 }] }),
    ],
    ["without a run", (live: Report) => ({ ...live, runUrl: undefined })],
    [
      "with a row that has no score",
      (live: Report) => ({
        ...live,
        rows: live.rows.map(({ id, n }) => ({ id, n })),
      }),
    ],
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

  it("reads the run and the scores from a live report this code can read", () => {
    const live = report({ spend: 0 });
    expect(readLive(JSON.stringify(live))).toEqual({
      runUrl: live.runUrl,
      rows: live.rows.map(({ id, score }) => ({ id, score })),
    });
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
    readLive(JSON.stringify({ ...live, runUrl: "a value" }), (line) => {
      lines.push(line);
    });
    readLive("{", (line) => {
      lines.push(line);
    });
    expect(lines.join("\n")).toContain("at runUrl");
    expect(lines.join("\n")).toContain("not JSON");
    expect(lines.join("\n")).not.toContain("a value");
  });
});

// #154: the command line decides which report must parse. CI's own report,
// the first path, must, or the eval check would post a comment for an
// invalid report of its own. The live one is only compared with, so it may
// fail.
describe("the comment command", () => {
  const good = JSON.stringify(report({ "recall-a": 0.96, spend: 0 }));
  const older = JSON.stringify(report({ "recall-a": 0.9, spend: 0 }));
  const bad = [
    ["is not JSON", "{", SyntaxError],
    ["is not a report", JSON.stringify({ rows: [] }), ZodError],
  ] as const;
  const quiet = () => undefined;
  const run = (args: string[], files: Record<string, string>) =>
    commentFrom(
      args,
      (path) => {
        const raw = files[path];
        if (raw === undefined) throw new Error(`no file ${path}`);
        return raw;
      },
      quiet,
    );

  it.each(bad)(
    "fails when CI's report %s, even beside a good live one",
    (_, raw, error) => {
      expect(() =>
        run(["ci.json", "live.json"], { "ci.json": raw, "live.json": older }),
      ).toThrow(error);
    },
  );

  it.each(bad)(
    "fails when CI's report %s and there is no live one",
    (_, raw, error) => {
      expect(() =>
        run(["ci.json", "--no-live", "no-deploy"], { "ci.json": raw }),
      ).toThrow(error);
    },
  );

  it.each(bad)("prints a comment when only the live report %s", (_, raw) => {
    const text = run(["ci.json", "live.json"], {
      "ci.json": good,
      "live.json": raw,
    });
    expect(text).toContain("<!-- grantlink:eval -->");
    expect(text).toContain(
      "| Recall | Gold set A | 95% or more | 96.0% | - | go |",
    );
  });

  it("puts CI's report first and the live one second", () => {
    const text = run(["ci.json", "live.json"], {
      "ci.json": good,
      "live.json": older,
    });
    expect(text).toContain(
      "| Recall | Gold set A | 95% or more | 96.0% | 90.0% | go |",
    );
  });

  it("says why there is no live report", () => {
    const text = run(["ci.json", "--no-live", "no-deploy"], {
      "ci.json": good,
    });
    expect(text).toContain("No deploy of main has run yet");
  });

  it.each([
    ["an unknown reason", ["ci.json", "--no-live", "gone"], ZodError],
    ["no reason", ["ci.json", "--no-live"], ZodError],
    ["no second argument", ["ci.json"], /usage/u],
  ] as const)("refuses %s", (_, args, error) => {
    expect(() => run([...args], { "ci.json": good })).toThrow(error);
  });
});
