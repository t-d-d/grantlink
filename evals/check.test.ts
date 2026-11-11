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

const s2 = { id: "s2", manifestSha256: "c".repeat(64) };
const s3 = { id: "s3", manifestSha256: "d".repeat(64) };

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

// Gold set A2's recall, the rules alone and one model, with the rules
// then the model at `then`.
const goldA2 = (rules: number, then = rules) => ({
  rules: { score: rules, n: 300 },
  models: [
    {
      modelId: "anthropic/claude-haiku-5.5",
      alone: { score: 0.5, n: 300 },
      rulesThen: { score: then, n: 300 },
      unprocessed: 3,
    },
  ],
});

describe("fitness: a gold set A2 row below any floor fails no gate (evals.md)", () => {
  it("passes a report whatever gold set A2 scores", () => {
    const result = gate(
      JSON.stringify({
        ...report({ "recall-a": 0.96, spend: 0 }),
        goldA2: goldA2(0, 0),
      }),
      "a".repeat(64),
    );
    expect(result.pass).toBe(true);
    expect(result.lines.join("\n")).not.toContain("no-go");
  });

  it("leaves the go/no-go table as it was", () => {
    expect(FLOORS.map((floor) => floor.id)).toEqual([
      "precision-b",
      "recall-b",
      "review-share",
      "recall-a",
      "model-adds",
      "spend",
    ]);
  });
});

describe("gold set A2 in the pull request's comment", () => {
  it("shows gold set A2's recall beside gold set A's, and says nobody tuned on it", () => {
    const text = comment(
      {
        ...report({ "recall-a": 0.96, spend: 0 }),
        candidates: [
          {
            modelId: "anthropic/claude-haiku-5.5",
            rows: rows({ "recall-a": 0.98, spend: 0.4 }),
            alone: rows({ "recall-a": 0.9, spend: 0.4 }),
            unprocessed: [],
          },
        ],
        goldA2: goldA2(0.91, 0.93),
      },
      "no-deploy",
    );
    expect(text).toContain(
      "#### Recall on gold set A and held-out gold set A2",
    );
    expect(text).toContain(
      "| On | Rules alone | anthropic/claude-haiku-5.5 alone | Rules then anthropic/claude-haiku-5.5 |",
    );
    expect(text).toContain("| Gold set A | 96.0% | 90.0% | 98.0% |");
    expect(text).toContain("| Gold set A2, held out | 91.0% | 50.0% | 93.0% |");
    expect(text).toContain(
      "Nobody tuned the rules or the prompt on gold set A2.",
    );
    expect(text).toContain("Gold set A2 gates nothing.");
    expect(text).toContain(
      "anthropic/claude-haiku-5.5 left 3 gold set A2 papers unread, and they count as missed.",
    );
  });

  it("says gold set A2 waits for its snapshot while it has no score", () => {
    const text = comment(
      {
        ...report({ spend: 0 }),
        goldA2: { rules: { score: null, n: 0 }, models: [] },
      },
      "no-deploy",
    );
    expect(text).toContain("| Gold set A2, held out | awaiting snapshot |");
  });

  it("shows no gold set A2 table for a report filed before it joined", () => {
    const text = comment(report({ spend: 0 }), "no-deploy");
    expect(text).not.toContain("gold set A2");
  });
});

describe("the pull request's comment", () => {
  it("shows CI's scores beside the live release's, with the runs behind each", () => {
    const text = comment(report({ "recall-a": 0.96, spend: 0 }), {
      ...report({ "recall-a": 0.9, spend: 0 }),
      runUrl: "https://github.com/t-d-d/grantlink/actions/runs/99",
      snapshot: null,
    });
    expect(text).toContain(
      "| Recall | Gold set A | 95% or more | 96.0% | 90.0% | go |",
    );
    expect(text).toContain("actions/runs/123");
    expect(text).toContain("actions/runs/99");
    expect(text).toContain("<!-- grantlink:eval -->");
  });

  it("shows recall and spend for the rules alone and for each model", () => {
    const text = comment(
      {
        ...report({ "recall-a": 0.96, spend: 0 }),
        candidates: [
          {
            modelId: "anthropic/claude-haiku-5.5",
            rows: rows({ "recall-a": 0.98, spend: 0.4 }),
            unprocessed: [],
          },
          {
            modelId: "anthropic/claude-sonnet-5.5",
            rows: rows({ "recall-a": 0.99, spend: 4.2 }),
            unprocessed: ["PMC7"],
          },
        ],
      },
      "no-deploy",
    );
    expect(text).toContain(
      "| Measure | On | Rules alone | anthropic/claude-haiku-5.5 | anthropic/claude-sonnet-5.5 |",
    );
    expect(text).toContain("| Recall | Gold set A | 96.0% | 98.0% | 99.0% |");
    expect(text).toContain(
      "| Model spend | Per 1,000 papers | $0.00 | $0.40 | $4.20 |",
    );
    // A gold set B row with no snapshot says what it waits for.
    expect(text).toContain(
      "| Recall of true CRUK references | Gold set B | awaiting snapshot | awaiting snapshot | awaiting snapshot |",
    );
    expect(text).toContain(
      "anthropic/claude-sonnet-5.5 left 1 paper for the next run: PMC7.",
    );
    // A report filed before the eval scored a model alone names no
    // model-alone column.
    expect(text).toContain("#### The rules alone and with each model");
  });

  it("gives each model a column alone and one after the rules", () => {
    const text = comment(
      {
        ...report({ "recall-a": 0.96, spend: 0 }),
        candidates: [
          {
            modelId: "anthropic/claude-haiku-5.5",
            rows: rows({ "recall-a": 0.98, spend: 0.4 }),
            alone: rows({ "recall-a": 0.9, spend: 0.4 }),
            unprocessed: [],
          },
          {
            modelId: "anthropic/claude-sonnet-5.5",
            rows: rows({ "recall-a": 0.99, spend: 4.2 }),
            alone: rows({ "recall-a": 0.93, spend: 4.2 }),
            unprocessed: [],
          },
        ],
      },
      "no-deploy",
    );
    expect(text).toContain(
      "#### The rules alone, each model alone, and the rules then each model",
    );
    expect(text).toContain(
      "| Measure | On | Rules alone | anthropic/claude-haiku-5.5 alone | Rules then anthropic/claude-haiku-5.5 | anthropic/claude-sonnet-5.5 alone | Rules then anthropic/claude-sonnet-5.5 |",
    );
    expect(text).toContain(
      "| Recall | Gold set A | 96.0% | 90.0% | 98.0% | 93.0% | 99.0% |",
    );
    // Nothing alone adds anything after the rules.
    expect(text).toContain(
      "| What the model adds | Gold set B | not measured yet | - | not measured yet | - | not measured yet |",
    );
  });

  it("shows no model table for a report with no candidates", () => {
    const text = comment(report({ spend: 0 }), "no-deploy");
    expect(text).not.toContain("Rules alone");
  });

  it("says when main has not been deployed yet", () => {
    const text = comment(report({ spend: 0 }), "no-deploy");
    expect(text).toContain("No deploy of main has run yet");
    // The live release is read from the page now, not from deploy.yml's
    // newest runs (#85).
    expect(text).not.toContain("recent runs");
  });

  it("says the live report is not known when its record cannot be read or holds none", () => {
    const text = comment(report({ spend: 0 }), "page-unread");
    expect(text).toContain(
      "The release record on the live page could not be read, or holds no report",
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

  // #138, #153: a pull request that adds a row or a field reads a live
  // report filed by older code. The comparison is advice, so the comment
  // keeps the live scores for the rows both reports share.
  it("keeps the live scores for the rows an older live report has", () => {
    const older = report({ "recall-a": 0.9, spend: 0 });
    const live = readLive(
      JSON.stringify({ ...older, rows: older.rows.slice(0, -1) }),
      () => undefined,
    );
    expect(live).not.toBe("unreadable");
    if (live === "unreadable") return;
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
    expect(live).not.toBe("unreadable");
    if (live === "unreadable") return;
    const text = comment(report({ "recall-a": 0.96, spend: 0 }), live);
    expect(text).toContain(
      "| Recall | Gold set A | 95% or more | 96.0% | 90.0% | go |",
    );
    // The unknown row's score would show if rows were read by position.
    expect(text).not.toContain("10.0%");
  });

  // #169: newer code may file a row this code does not know, with a score
  // of another shape. That row is never compared, so it does not cost the
  // comment the live scores for the rows both reports share.
  it("ignores a malformed row it does not know, keeping the shared live scores", () => {
    const newer = report({ "recall-a": 0.9, spend: 0 });
    const live = readLive(
      JSON.stringify({
        ...newer,
        rows: [
          ...newer.rows,
          { id: "added-later", score: { low: 0.1, high: 0.2 }, n: 3 },
          { score: "unnamed" },
          "not a row",
        ],
      }),
      () => undefined,
    );
    expect(live).not.toBe("unreadable");
    if (live === "unreadable") return;
    const text = comment(report({ "recall-a": 0.96, spend: 0 }), live);
    expect(text).toContain(
      "| Recall | Gold set A | 95% or more | 96.0% | 90.0% | go |",
    );
  });

  it("logs where a known row is malformed, by its place in the live report", () => {
    const lines: string[] = [];
    const live = report({ spend: 0 });
    const [first, ...rest] = live.rows;
    if (first === undefined) throw new Error("no rows");
    readLive(
      JSON.stringify({
        ...live,
        rows: [
          { id: "added-later", score: {} },
          { id: first.id, score: "high" },
          ...rest,
        ],
      }),
      (line) => {
        lines.push(line);
      },
    );
    expect(lines.join("\n")).toContain("invalid_type at rows.1.score");
    expect(lines.join("\n")).not.toContain("high");
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
    expect(live).toBe("unreadable");
    const text = comment(report({ "recall-a": 0.96, spend: 0 }), live);
    expect(text).toContain(
      "| Recall | Gold set A | 95% or more | 96.0% | - | go |",
    );
    expect(text).toContain(
      "The live release's report is in a format this pull request's code cannot read",
    );
    // Newer code can file a report this code cannot read too, so the
    // reason does not guess which it is (#186).
    expect(text).not.toMatch(/\bolder\b/i);
  });

  it("reads the run, the snapshot and the scores from a live report this code can read", () => {
    const live = { ...report({ spend: 0 }), snapshot: s2 };
    expect(readLive(JSON.stringify(live))).toEqual({
      runUrl: live.runUrl,
      snapshot: "s2",
      rows: live.rows.map(({ id, score }) => ({ id, score })),
    });
  });

  it.each([
    ["has no snapshot yet", null],
    ["is from before reports named one", undefined],
  ])("reads the snapshot as null when the live report %s", (_, snapshot) => {
    const live = readLive(
      JSON.stringify({ ...report({ spend: 0 }), snapshot }),
      () => undefined,
    );
    expect(live).not.toBe("unreadable");
    if (live === "unreadable") return;
    expect(live.snapshot).toBeNull();
  });

  // #232: scores compare only while the text stays the same (evals.md), so
  // a gap between two snapshots must not read as a regression.
  it("says when the live scores come from another snapshot, and names both", () => {
    const live = readLive(
      JSON.stringify({
        ...report({ "recall-a": 0.97, spend: 0 }),
        snapshot: s2,
      }),
      () => undefined,
    );
    expect(live).not.toBe("unreadable");
    if (live === "unreadable") return;
    const text = comment(
      { ...report({ "recall-a": 0.9, spend: 0 }), snapshot: s3 },
      live,
    );
    expect(text).toContain(
      "The live release was scored on snapshot s2 and this pull request on snapshot s3, so their scores do not compare.",
    );
    expect(text.indexOf("do not compare")).toBeLessThan(
      text.indexOf("| Measure |"),
    );
  });

  it("says when only one of the two was scored on a snapshot", () => {
    const live = readLive(
      JSON.stringify({ ...report({ spend: 0 }), snapshot: null }),
      () => undefined,
    );
    expect(live).not.toBe("unreadable");
    if (live === "unreadable") return;
    const text = comment({ ...report({ spend: 0 }), snapshot: s3 }, live);
    expect(text).toContain(
      "The live release was scored on no snapshot and this pull request on snapshot s3, so their scores do not compare.",
    );
  });

  // The id goes into the comment, so it keeps the strict report's bounds,
  // as runUrl does.
  it.each([
    ["empty", ""],
    ["longer than a report allows", "s".repeat(21)],
  ])(
    "treats a live report whose snapshot id is %s as one it cannot read",
    (_, id) => {
      const live = JSON.stringify({
        ...report({ spend: 0 }),
        snapshot: { ...s2, id },
      });
      expect(readLive(live, () => undefined)).toBe("unreadable");
    },
  );

  it("says nothing about snapshots when both were scored on the same one", () => {
    const live = readLive(
      JSON.stringify({ ...report({ spend: 0 }), snapshot: s3 }),
      () => undefined,
    );
    expect(live).not.toBe("unreadable");
    if (live === "unreadable") return;
    const text = comment({ ...report({ spend: 0 }), snapshot: s3 }, live);
    expect(text).not.toContain("do not compare");
  });

  it("treats a live report that is not JSON as one it cannot read", () => {
    expect(readLive("{", () => undefined)).toBe("unreadable");
  });

  // The comment shows only that the live report could not be read. The
  // job's log keeps why, as paths and codes and never values, so a broken
  // report, an older one and a newer one can still be told apart.
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
