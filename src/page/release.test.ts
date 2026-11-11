import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLOORS } from "../../evals/floors.ts";
import { RULES_ALONE, type Report } from "../../evals/report.ts";
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
  modelId: RULES_ALONE,
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

  // The release reads with the rules alone, as #330 decided, and the eval
  // still scores each model beside them.
  const candidate = (modelId: string, adds: number, spend: number) => ({
    modelId,
    rows: rows({ ...scores, "model-adds": adds, spend }),
    unprocessed: [],
  });
  const rulesAlone = renderRun(
    makeRelease({
      ...fields,
      report: {
        ...report,
        candidates: [
          candidate("anthropic/claude-haiku-5.5", 0.039, 0.15),
          candidate("anthropic/claude-sonnet-5.5", 0.029, 2.61),
        ],
      },
    }),
  );
  const modelAddsRow = (html: string) =>
    /<tr><td>What the model adds<\/td>.*?<\/tr>/u.exec(html)?.[0] ?? "";

  it("says rules ship alone beside the go/no-go table, with what each model adds", () => {
    expect(rulesAlone).toContain("Rules ship alone");
    expect(rulesAlone).toContain("calls no model");
    expect(rulesAlone).not.toContain(RULES_ALONE);
    expect(rulesAlone).toContain("anthropic/claude-haiku-5.5");
    expect(rulesAlone).toContain("3.9 points");
    expect(rulesAlone).toContain("$0.15 per 1,000 papers");
    expect(rulesAlone).toContain("anthropic/claude-sonnet-5.5");
    expect(rulesAlone).toContain("2.9 points");
    expect(rulesAlone).toContain("$2.61 per 1,000 papers");
    expect(rulesAlone).toContain(
      'href="https://github.com/t-d-d/grantlink/issues/330"',
    );
  });

  it("gives rules shipping alone as what the model adds, not as unmeasured", () => {
    expect(modelAddsRow(rulesAlone)).toContain("Rules ship alone");
    expect(modelAddsRow(rulesAlone)).not.toContain("not measured yet");
  });

  it("leaves out a model with no score, and a spend not measured", () => {
    const partial = renderRun(
      makeRelease({
        ...fields,
        report: {
          ...report,
          candidates: [
            {
              ...candidate("anthropic/claude-haiku-5.5", 0, 0),
              rows: rows({}),
            },
            {
              ...candidate("anthropic/claude-sonnet-5.5", 0, 0),
              rows: rows({ "model-adds": 0.02 }),
            },
          ],
        },
      }),
    );
    expect(partial).not.toContain("anthropic/claude-haiku-5.5");
    expect(partial).toContain(
      "anthropic/claude-sonnet-5.5</code> adds 2.0 points of recall on gold set B.",
    );
    expect(partial).not.toContain("per 1,000 papers");
  });

  it("gives each model's precision and recall on gold set B alone, beside the rules alone", () => {
    const onB = {
      ...scores,
      "precision-b": 1,
      "recall-b": 0.922,
    };
    const scoredB = {
      ...report,
      rows: rows(onB),
      baseline: rows(onB),
    };
    const withAlone = renderRun(
      makeRelease({
        ...fields,
        report: {
          ...scoredB,
          candidates: [
            {
              ...candidate("anthropic/claude-haiku-5.5", 0.039, 0.15),
              alone: rows({ "precision-b": 0.98, "recall-b": 0.912 }),
            },
            {
              ...candidate("anthropic/claude-sonnet-5.5", 0.029, 2.61),
              alone: rows({ "precision-b": 0.957, "recall-b": 0.873 }),
            },
          ],
        },
      }),
    );
    const table =
      /<table class="models">[\s\S]*?<\/table>/u.exec(withAlone)?.[0] ?? "";
    expect(table).toContain(
      '<tr><th scope="row">Rules alone</th><td class="count">100.0%</td><td class="count">92.2%</td><td class="count">-</td></tr>',
    );
    expect(table).toContain(
      '<tr><th scope="row"><code class="ref">anthropic/claude-haiku-5.5</code> alone</th><td class="count">98.0%</td><td class="count">91.2%</td><td class="count">3.9 points</td></tr>',
    );
    expect(table).toContain(
      '<tr><th scope="row"><code class="ref">anthropic/claude-sonnet-5.5</code> alone</th><td class="count">95.7%</td><td class="count">87.3%</td><td class="count">2.9 points</td></tr>',
    );
    // The note on gold set B's labels covers the model-alone scores too.
    expect(withAlone).toContain(
      "may favour a model over the rules, so read what each model scores alone, and what it adds after the rules, with that in mind.",
    );
  });

  it("leaves out a model alone with no score on gold set B", () => {
    const unscored = renderRun(
      makeRelease({
        ...fields,
        report: {
          ...report,
          candidates: [
            {
              ...candidate("anthropic/claude-haiku-5.5", 0, 0),
              rows: rows({}),
              alone: rows({}),
            },
          ],
        },
      }),
    );
    expect(unscored).not.toContain("anthropic/claude-haiku-5.5");
    expect(unscored).not.toContain('<table class="models">');
  });

  describe("a model's unread papers (#696)", () => {
    const onB = { ...scores, "precision-b": 1, "recall-b": 0.922 };
    const withRead = (goldB: number) =>
      renderRun(
        makeRelease({
          ...fields,
          report: {
            ...report,
            rows: rows(onB),
            baseline: rows(onB),
            candidates: [
              {
                ...candidate("anthropic/claude-sonnet-5.5", 0.029, 2.61),
                alone: rows(
                  goldB === 0
                    ? {}
                    : { "precision-b": 0.957, "recall-b": 0.873 },
                ),
                unprocessed: ["PMC7"],
                read: { goldA: 300, goldB },
              },
            ],
          },
        }),
      );

    it("says how many gold papers each model read alone", () => {
      expect(withRead(299)).toContain(
        "anthropic/claude-sonnet-5.5 alone read 300 of 300 papers in gold set A and 299 of 300 in gold set B. Its scores alone leave out the papers it did not read.",
      );
    });

    it("shows no score alone on a gold set the model read none of", () => {
      const html = withRead(0);
      const table =
        /<table class="models">[\s\S]*?<\/table>/u.exec(html)?.[0] ?? "";
      expect(table).toContain(
        '<tr><th scope="row"><code class="ref">anthropic/claude-sonnet-5.5</code> alone</th><td class="count">-</td><td class="count">-</td><td class="count">2.9 points</td></tr>',
      );
      expect(html).toContain("0 of 300 in gold set B");
      // No 0% precision or recall for the papers it never read.
      expect(table).not.toContain('<td class="count">0.0%</td>');
    });
  });

  it("renders a report with no model-alone rows as before", () => {
    expect(rulesAlone).not.toContain('<table class="models">');
    expect(rulesAlone).toContain(
      "anthropic/claude-haiku-5.5</code> adds 3.9 points of recall on gold set B, for $0.15 per 1,000 papers.",
    );
  });

  it("says rules ship alone when the eval scored no model", () => {
    expect(section).toContain("Rules ship alone");
    expect(section).toContain("calls no model");
    expect(section).not.toContain("claude");
  });

  it("names the model when the release calls one", () => {
    const withModel = renderRun(
      makeRelease({
        ...fields,
        report: { ...report, modelId: "anthropic/claude-haiku-5.5" },
      }),
    );
    expect(withModel).toContain("with model anthropic/claude-haiku-5.5");
    expect(withModel).not.toContain("Rules ship alone");
    expect(modelAddsRow(withModel)).toContain("not measured yet");
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

describe("the page's intro", () => {
  const intro = template.replace(/\s+/gu, " ");

  it("says the eval scored each model alone and after the rules, and why the rules ship alone", () => {
    expect(intro).toContain(
      "Its evaluation scored each model alone and after the rules.",
    );
    expect(intro).toContain(
      "The rules ship alone, because no model adds 10 points of recall after them.",
    );
    expect(intro).not.toContain("did not find enough more to ship");
  });
});

describe("gold set A2 on the page (#706)", () => {
  const withA2 = (goldA2: Report["goldA2"]) =>
    renderRun(
      makeRelease({
        ...fields,
        report: {
          ...report,
          candidates: [
            {
              modelId: "anthropic/claude-haiku-5.5",
              rows: rows({ ...scores, "recall-a": 0.98, spend: 0.15 }),
              alone: rows({ "recall-a": 0.9, spend: 0.15 }),
              unprocessed: [],
            },
          ],
          goldA2,
        },
      }),
    );
  const scored = withA2({
    rules: { score: 0.94, n: 300 },
    models: [
      {
        modelId: "anthropic/claude-haiku-5.5",
        alone: { score: 0.88, n: 300 },
        rulesThen: { score: 0.96, n: 300 },
        unprocessed: 0,
      },
    ],
  });
  const table = (html: string) =>
    /<table class="held-out">[\s\S]*?<\/table>/u.exec(html)?.[0] ?? "";

  it("shows gold set A2's recall beside gold set A's, for the rules and each model", () => {
    expect(table(scored)).toContain(
      '<tr><th scope="col">Read by</th><th scope="col">Recall on gold set A</th><th scope="col">Recall on gold set A2, held out</th></tr>',
    );
    expect(table(scored)).toContain(
      '<tr><th scope="row">Rules alone</th><td class="count">97.0%</td><td class="count">94.0%</td></tr>',
    );
    expect(table(scored)).toContain(
      '<tr><th scope="row"><code class="ref">anthropic/claude-haiku-5.5</code> alone</th><td class="count">90.0%</td><td class="count">88.0%</td></tr>',
    );
    expect(table(scored)).toContain(
      '<tr><th scope="row">Rules then <code class="ref">anthropic/claude-haiku-5.5</code></th><td class="count">98.0%</td><td class="count">96.0%</td></tr>',
    );
  });

  it("says nobody tuned the rules or the prompt on gold set A2, and that it gates nothing", () => {
    expect(scored).toContain(
      "Nobody tuned the rules or the prompt on gold set A2",
    );
    expect(scored).toContain("Gold set A2 gates nothing");
    expect(scored).toContain(
      'href="https://github.com/t-d-d/grantlink/issues/695"',
    );
  });

  it("shows no gold set A2 table before gold set A2 has a score", () => {
    const waiting = withA2({ rules: { score: null, n: 0 }, models: [] });
    expect(table(waiting)).toBe("");
    expect(table(renderRun(makeRelease(fields)))).toBe("");
  });
});

describe("gold set B2 on the page (#702)", () => {
  const bScores = { ...scores, "precision-b": 0.97, "recall-b": 0.92 };
  const both = (precision: number | null, recall: number | null, n = 100) => ({
    precision: { score: precision, n },
    recall: { score: recall, n },
  });
  const withB2 = (goldB2: Report["goldB2"]) =>
    renderRun(
      makeRelease({
        ...fields,
        report: {
          ...report,
          rows: rows(bScores),
          baseline: rows(bScores),
          candidates: [
            {
              modelId: "anthropic/claude-haiku-5.5",
              rows: rows({ ...bScores, "recall-b": 0.94, spend: 0.15 }),
              alone: rows({ "precision-b": 0.9, "recall-b": 0.91 }),
              unprocessed: [],
            },
          ],
          goldB2,
        },
      }),
    );
  const scored = withB2({
    rules: both(0.93, 0.85),
    models: [
      {
        modelId: "anthropic/claude-haiku-5.5",
        alone: both(0.8, 0.7),
        rulesThen: both(0.9, 0.95),
        unprocessed: 0,
        read: 100,
      },
    ],
  });
  const table = (html: string) =>
    /<table class="held-out-b2">[\s\S]*?<\/table>/u.exec(html)?.[0] ?? "";

  it("shows gold set B2's precision and recall beside gold set B's, for the rules and each model", () => {
    expect(table(scored)).toContain(
      '<tr><th scope="col">Read by</th><th scope="col">Precision on gold set B</th><th scope="col">Precision on gold set B2, held out</th><th scope="col">Recall on gold set B</th><th scope="col">Recall on gold set B2, held out</th></tr>',
    );
    expect(table(scored)).toContain(
      '<tr><th scope="row">Rules alone</th><td class="count">97.0%</td><td class="count">93.0%</td><td class="count">92.0%</td><td class="count">85.0%</td></tr>',
    );
    expect(table(scored)).toContain(
      '<tr><th scope="row"><code class="ref">anthropic/claude-haiku-5.5</code> alone</th><td class="count">90.0%</td><td class="count">80.0%</td><td class="count">91.0%</td><td class="count">70.0%</td></tr>',
    );
    expect(table(scored)).toContain(
      '<tr><th scope="row">Rules then <code class="ref">anthropic/claude-haiku-5.5</code></th><td class="count">97.0%</td><td class="count">90.0%</td><td class="count">94.0%</td><td class="count">95.0%</td></tr>',
    );
  });

  it("says nobody tuned the rules or the prompt on gold set B2, that a Claude model proposed its labels and the owner checked them, and that it gates nothing", () => {
    expect(scored).toContain(
      "Nobody tuned the rules or the prompt on gold set B2",
    );
    expect(scored).toContain(
      "A Claude model proposed gold set B2's labels and the owner checked them",
    );
    expect(scored).toContain("Gold set B2 gates nothing");
  });

  it("shows no gold set B2 table before gold set B2 has a score", () => {
    const waiting = withB2({ rules: both(null, null, 0), models: [] });
    expect(table(waiting)).toBe("");
    expect(table(renderRun(makeRelease(fields)))).toBe("");
  });
});
