import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PaperRow } from "../store/table.ts";
import { found as foundSchema, summarise } from "./found.ts";
import { rebuild } from "./build.ts";
import { buildPage, renderFound } from "./render.ts";

const template = readFileSync(
  new URL("../../site/index.html", import.meta.url),
  "utf8",
);

const row = (pmcid: string, more: Partial<PaperRow> = {}): PaperRow => ({
  pmcid,
  title: `Title of ${pmcid}`,
  status: "pending",
  foundAt: "2026-11-09T10:00:00.000Z",
  ...more,
});

const done = (pmcid: string, references: PaperRow["references"] = []) =>
  row(pmcid, {
    status: "processed",
    references,
    versions: { rules: "rules-1", code: "abc" },
    processedAt: "2026-11-09T10:05:00.000Z",
    runId: "run-1",
  });

const ca = {
  asWritten: "C1234/A56789",
  normalised: "C1234/A56789",
  format: "Cn/An",
};
const an = { asWritten: "A 28707", normalised: "A28707", format: "An" };

const rows = [
  done("PMC1", [ca, an]),
  done("PMC2", [{ ...ca, asWritten: "C1234 / A56789" }]),
  done("PMC3"),
  row("PMC4", { failures: 1 }),
];

const run = { runId: "run-1", finishedAt: "2026-11-09T12:00:00.000Z" };

describe("what the run found", () => {
  const found = summarise(rows, run);

  it("counts the papers and the references", () => {
    expect(found.counts).toEqual({
      papers: 4,
      processed: 3,
      withReference: 2,
      references: 3,
      pending: 1,
    });
  });

  it("lists the papers with a reference, and the papers not yet processed", () => {
    expect(found.papers.map((paper) => paper.pmcid)).toEqual(["PMC1", "PMC2"]);
    expect(found.pending).toEqual([{ pmcid: "PMC4", title: "Title of PMC4" }]);
  });

  it("counts each reference format, most common first", () => {
    expect(found.formats).toEqual([
      { format: "Cn/An", count: 2 },
      { format: "An", count: 1 },
    ]);
  });

  it("parses as the data the deploy reads back", () => {
    expect(foundSchema.parse(JSON.parse(JSON.stringify(found)))).toEqual(found);
  });
});

describe("fitness: the page shows only titles, links and references (no-republished-text.md)", () => {
  const found = summarise(rows, run);

  it("keeps only the pmcid, the title and the references of each paper", () => {
    for (const paper of found.papers) {
      expect(Object.keys(paper).sort()).toEqual([
        "pmcid",
        "references",
        "title",
      ]);
      for (const reference of paper.references) {
        expect(Object.keys(reference).sort()).toEqual([
          "asWritten",
          "format",
          "normalised",
        ]);
      }
    }
    for (const paper of found.pending) {
      expect(Object.keys(paper).sort()).toEqual(["pmcid", "title"]);
    }
  });

  it("refuses data with any other field", () => {
    const extra = JSON.parse(JSON.stringify(found)) as {
      papers: Record<string, unknown>[];
    };
    if (extra.papers[0]) extra.papers[0].abstract = "An abstract.";
    expect(() => foundSchema.parse(extra)).toThrow();
  });

  it("shows each reference as a row of title, reference, normalised reference and status", () => {
    const html = renderFound(found);
    const table =
      /<table class="references">([\s\S]*?)<\/table>/u.exec(html)?.[1] ?? "";
    const bodyRows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/gu)].slice(1);
    expect(bodyRows).toHaveLength(3);
    for (const [, cells = ""] of bodyRows) {
      expect(cells.match(/<td\b/gu)).toHaveLength(4);
    }
  });
});

describe("fitness: links are labelled as proposed by software, with no warranty (accuracy.md)", () => {
  const html = renderFound(summarise(rows, run));

  it("labels every link as proposed by software", () => {
    expect(
      html.match(/<td class="status">Proposed by software<\/td>/gu),
    ).toHaveLength(3);
  });

  it("says the links are proposed by software and come with no warranty", () => {
    expect(html).toMatch(/proposed by software/u);
    expect(html).toMatch(/no warranty/u);
  });

  it("says the same before any run", () => {
    const words = template.replace(/\s+/gu, " ");
    expect(words).toMatch(/proposed by software/u);
    expect(words).toMatch(/none comes with a warranty/u);
  });
});

describe("rendering the page", () => {
  it("links each title to the paper on Europe PMC", () => {
    expect(renderFound(summarise(rows, run))).toContain(
      '<a href="https://europepmc.org/article/PMC/PMC1">Title of PMC1</a>',
    );
  });

  it("escapes what it shows", () => {
    const html = renderFound(
      summarise(
        [done("PMC9", [ca])].map((r) => ({
          ...r,
          title: '<script>"x"</script> & y',
        })),
        run,
      ),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain(
      "&lt;script&gt;&quot;x&quot;&lt;/script&gt; &amp; y",
    );
  });

  it("says what each reference format means, including a bare number", () => {
    const html = renderFound(summarise(rows, run));
    expect(html).toContain("Cn/An is the older");
    expect(html).toContain("and n a bare award");
  });

  it("puts the findings in place of the not-yet-run notice, and keeps the rest of the page", () => {
    const page = buildPage(template, summarise(rows, run));
    expect(page).not.toContain("Not yet run");
    expect(page).toContain("What it found");
    expect(page).toContain(
      "not affiliated with or endorsed by Cancer Research UK",
    );
    expect(page.startsWith("<!doctype html>")).toBe(true);
  });

  it("builds the not-yet-run page when there is no data", () => {
    expect(buildPage(template, null)).toBe(template);
  });

  it("refuses a template without the place for the findings", () => {
    expect(() => buildPage("<html></html>", summarise(rows, run))).toThrow();
  });
});

describe("building the page again at deploy", () => {
  it("builds the same page from the published data", () => {
    const found = summarise(rows, run);
    expect(rebuild(template, JSON.stringify(found), null)).toBe(
      buildPage(template, found),
    );
  });

  it("builds the page before any run, with no findings", () => {
    expect(rebuild(template, null, null)).toBe(template);
  });

  it("refuses data it cannot read", () => {
    expect(() =>
      rebuild(template, JSON.stringify({ papers: [] }), null),
    ).toThrow();
    expect(() => rebuild(template, null, JSON.stringify({}))).toThrow();
  });
});
