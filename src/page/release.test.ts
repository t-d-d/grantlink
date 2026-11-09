import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLOORS } from "../../evals/floors.ts";
import type { Report } from "../../evals/report.ts";
import { makeRelease, type Release } from "./release.ts";
import { buildPage, renderRun } from "./render.ts";

const template = readFileSync(
  new URL("../../site/index.html", import.meta.url),
  "utf8",
);

const rows = (scores: Partial<Record<string, number>>) =>
  FLOORS.map((floor) => ({
    id: floor.id,
    score: scores[floor.id] ?? null,
    n: 300,
  }));

const scores = { "recall-a": 0.97, spend: 0 };

const report: Report = {
  fingerprint: "f".repeat(64),
  commit: "e".repeat(40),
  runUrl: "https://github.com/t-d-d/grantlink/actions/runs/111",
  modelId: "none: rules only",
  rulesVersion: "rules-1",
  snapshot: { id: "s1", manifestSha256: "d".repeat(64) },
  createdAt: "2026-11-09T12:00:00.000Z",
  rows: rows(scores),
  baseline: rows(scores),
  missedA: [],
};

const fields: Release = {
  commit: "c".repeat(40),
  fingerprint: "f".repeat(64),
  deployRunUrl: "https://github.com/t-d-d/grantlink/actions/runs/222",
  report,
};

describe("fitness: every release names its report (deploy-gates.md)", () => {
  it("records the commit, the fingerprint, the report and both runs", () => {
    expect(makeRelease(fields)).toEqual(fields);
  });

  it("refuses a release without a fingerprint", () => {
    expect(() => makeRelease({ ...fields, fingerprint: "" })).toThrow();
  });

  it("refuses a release whose report has no run URL", () => {
    expect(() =>
      makeRelease({ ...fields, report: { ...report, runUrl: "" } }),
    ).toThrow();
  });

  it("refuses a report filed for another fingerprint", () => {
    expect(() =>
      makeRelease({ ...fields, fingerprint: "0".repeat(64) }),
    ).toThrow(/fingerprint/u);
  });

  it("refuses a report below a gating floor", () => {
    expect(() =>
      makeRelease({
        ...fields,
        report: { ...report, rows: rows({ "recall-a": 0.5, spend: 0 }) },
      }),
    ).toThrow(/floor/u);
  });
});

describe("how it's run, on the page", () => {
  const section = renderRun(makeRelease(fields));

  it("shows the go/no-go table for the live release, beside the rules alone", () => {
    expect(section).toContain("How it's run");
    for (const floor of FLOORS) expect(section).toContain(floor.measure);
    expect(section).toContain("97.0%");
    expect(section).toContain("Rules alone");
    expect(section).toContain("awaiting snapshot");
    expect(section).not.toContain("awaiting labels");
  });

  it("links to the deploy's run and the report's run, and names the snapshot", () => {
    expect(section).toContain(
      'href="https://github.com/t-d-d/grantlink/actions/runs/222"',
    );
    expect(section).toContain(
      'href="https://github.com/t-d-d/grantlink/actions/runs/111"',
    );
    expect(section).toContain("d".repeat(64));
  });

  it("says how gold set B's labels were made once gold set B is scored", () => {
    const scored = { "precision-b": 0.96, "recall-b": 0.81, ...scores };
    const withB = renderRun(
      makeRelease({
        ...fields,
        report: { ...report, rows: rows(scored), baseline: rows(scored) },
      }),
    );
    expect(withB).toContain("proposed by two passes of a Claude model");
    expect(withB).toContain("checked by the owner");
    expect(withB).toContain("changed none of the");
    expect(withB).toContain(
      'href="https://github.com/t-d-d/grantlink/issues/175"',
    );
    expect(section).not.toContain("two passes of a Claude model");
  });

  it("says when no snapshot is pinned yet", () => {
    const early = makeRelease({
      ...fields,
      report: { ...report, snapshot: null },
    });
    expect(renderRun(early)).toContain("No eval snapshot is pinned yet");
  });

  it("takes the place of its notice, with or without findings", () => {
    const page = buildPage(template, null, makeRelease(fields));
    expect(page).toContain("actions/runs/222");
    expect(page).toContain("Not yet run");
    expect(page).not.toContain("No release has been recorded yet");
  });

  it("keeps its notice when no release is recorded", () => {
    expect(buildPage(template, null, null)).toContain(
      "No release has been recorded yet",
    );
  });
});
