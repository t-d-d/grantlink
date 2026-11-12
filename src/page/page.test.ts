import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTACT, NOTICE, footerOf, textOf } from "../../test/page.ts";
import type { PaperRow } from "../store/table.ts";
import {
  found as foundSchema,
  isNotice,
  leaveOut,
  summarise,
  withoutNotices,
} from "./found.ts";
import { rebuild, retracted } from "./build.ts";
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
  foundByRun: "run-1",
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

describe("a reference with a character a later version allows", () => {
  // A made-up reference in a shape a later version might allow: an
  // underscore, which referenceSchema does not (#314, #344).
  const later = { asWritten: "A_12345", normalised: "A_12345", format: "A_n" };

  it("builds the page from a row a later version wrote", () => {
    const found = summarise([done("PMC1", [later])], run);
    expect(found.papers).toEqual([
      { pmcid: "PMC1", title: "Title of PMC1", references: [later] },
    ]);
  });

  it("builds the page again at deploy from the found.json a later run published", () => {
    const found = summarise([done("PMC1", [later])], run);
    expect(rebuild(template, JSON.stringify(found), null)).toContain("A_12345");
  });

  it("still checks a reference's length and type, and refuses any other field", () => {
    const published = (reference: Record<string, unknown>) =>
      JSON.stringify({
        ...summarise([done("PMC1", [later])], run),
        papers: [{ pmcid: "PMC1", title: "Title", references: [reference] }],
      });
    expect(rebuild(template, published(later), null)).toContain("A_12345");
    expect(() =>
      rebuild(
        template,
        published({ ...later, asWritten: "A".repeat(49) }),
        null,
      ),
    ).toThrow();
    expect(() =>
      rebuild(template, published({ ...later, normalised: 12345 }), null),
    ).toThrow();
    expect(() =>
      rebuild(template, published({ ...later, format: "" }), null),
    ).toThrow();
    expect(() =>
      rebuild(template, published({ ...later, asWritten: "" }), null),
    ).toThrow();
    expect(() =>
      rebuild(
        template,
        published({ ...later, normalised: "A".repeat(41) }),
        null,
      ),
    ).toThrow();
    expect(() =>
      rebuild(template, published({ ...later, text: "A sentence." }), null),
    ).toThrow();
  });
});

describe("a paper the run's search no longer returns", () => {
  // Europe PMC has since linked these to a grant, or dropped them, so the
  // run's search, which asks for papers linked to none, did not return them.
  const found = summarise(
    [
      ...rows,
      done("PMC5", [ca]),
      { ...done("PMC6", [an]), foundByRun: "run-0" },
      row("PMC7", { foundByRun: "run-0" }),
      { ...done("PMC8", [ca]), foundByRun: undefined },
    ],
    run,
  );

  it("is neither listed nor counted", () => {
    expect(found.counts).toEqual({
      papers: 5,
      processed: 4,
      withReference: 3,
      references: 4,
      pending: 1,
    });
    expect(found.papers.map((paper) => paper.pmcid)).toEqual([
      "PMC1",
      "PMC2",
      "PMC5",
    ]);
    expect(found.pending.map((paper) => paper.pmcid)).toEqual(["PMC4"]);
    expect(found.formats).toEqual([
      { format: "Cn/An", count: 3 },
      { format: "An", count: 1 },
    ]);
  });
});

describe("a correction notice (#660)", () => {
  // Europe PMC marks a correction notice by its publication types, which
  // neither the table nor found.json keeps, so the page knows one by the
  // word its title starts with. Both notices the search returned in
  // November 2026 start this way, and no paper in it does.
  const notices = [
    "Correction: Title of a paper",
    "Corrigendum to: Title of a paper",
    "Erratum: Title of a paper",
    "Author Correction: Title of a paper",
    "Publisher Correction: Title of a paper",
    "CORRECTION: Title of a paper",
    "Correction to Title of a paper",
  ];
  const papers = [
    "A review of attenuation correction methods",
    "Correction of a defect in DNA repair",
    "Correctional facilities and cancer screening",
    "Erratum in the record of a trial",
    "Correction tools for sequencing errors",
  ];

  it("is known by its title, and a paper is not", () => {
    for (const title of notices) expect(isNotice(title)).toBe(true);
    for (const title of papers) expect(isNotice(title)).toBe(false);
  });

  const withNotices = [
    ...rows,
    { ...done("PMC5", [ca]), title: "Correction: Title of PMC1" },
    row("PMC6", { title: "Corrigendum to: Title of PMC2" }),
  ];

  it("is neither listed nor counted by the run", () => {
    const found = summarise(withNotices, run);
    expect(found).toEqual(summarise(rows, run));
  });

  it("is taken off the page at deploy, from a found.json that lists it", () => {
    const listed = {
      ...summarise(rows, run),
      counts: {
        papers: 6,
        processed: 4,
        withReference: 3,
        references: 6,
        pending: 2,
      },
      papers: [
        ...summarise(rows, run).papers,
        {
          pmcid: "PMC5",
          title: "Correction: Title of PMC1",
          references: [
            { ...an, format: "Notice" },
            { ...an, format: "Notice" },
            ca,
          ],
        },
      ],
      formats: [
        { format: "Cn/An", count: 3 },
        { format: "Notice", count: 2 },
        { format: "An", count: 1 },
      ],
      pending: [
        ...summarise(rows, run).pending,
        { pmcid: "PMC6", title: "Corrigendum to: Title of PMC2" },
      ],
    };
    expect(rebuild(template, JSON.stringify(listed), null)).toBe(
      buildPage(template, summarise(rows, run)),
    );
  });

  // The schema lets found.json list a paper with no reference, so taking
  // one off counts only what it gave.
  it("takes a listed notice with no reference out of the papers read only", () => {
    const data = summarise(rows, run);
    const listed = {
      ...data,
      counts: {
        ...data.counts,
        papers: data.counts.papers + 1,
        processed: data.counts.processed + 1,
      },
      papers: [
        ...data.papers,
        { pmcid: "PMC5", title: "Erratum: Title of PMC1", references: [] },
      ],
    };
    expect(withoutNotices(listed)).toEqual(data);
  });
});

describe("the search the page lists", () => {
  // Rows keep the mark of the latest-started run that returned them, so a
  // paper the latest complete search returned may carry a later run's mark.
  const marked = [
    done("PMC1", [ca]),
    { ...done("PMC2", [an]), foundByRun: "run-2" },
    row("PMC3", { foundByRun: "run-0" }),
  ];

  it("is the latest complete search, whichever run publishes", () => {
    const found = summarise(marked, run, "run-2");
    expect(found.runId).toBe("run-1");
    expect(found.papers.map((paper) => paper.pmcid)).toEqual(["PMC2"]);
  });

  it("takes in the papers a run that started after it has returned", () => {
    const found = summarise(marked, run, "run-1");
    expect(found.papers.map((paper) => paper.pmcid)).toEqual(["PMC1", "PMC2"]);
    expect(found.counts.papers).toBe(2);
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

  it("shows each paper in one row of title, references and status (#587)", () => {
    const html = renderFound(found);
    const table =
      /<table class="references">([\s\S]*?)<\/table>/u.exec(html)?.[1] ?? "";
    const bodyRows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/gu)].slice(1);
    expect(bodyRows).toHaveLength(2);
    for (const [, cells = ""] of bodyRows) {
      expect(cells.match(/<td\b/gu)).toHaveLength(3);
    }
    const first = bodyRows[0]?.[1] ?? "";
    expect(first).toContain("Title of PMC1");
    expect(first).toContain(">C1234/A56789<br>A28707</td>");
  });
});

describe("fitness: links are labelled as proposed by software, with no warranty (accuracy.md)", () => {
  const html = renderFound(summarise(rows, run));

  it("labels every link as proposed by software", () => {
    const labels = [...html.matchAll(/<td class="status">(.*?)<\/td>/gu)]
      .map(([, cell = ""]) => cell.split("<br>"))
      .flat();
    expect(labels).toEqual(Array(3).fill("Proposed by software"));
  });

  // found.json allows a paper with no references, and the deploy builds the
  // page from it. Such a paper has no link, so it gets no row without a status.
  it("lists no paper that has no reference", () => {
    const found = summarise(rows, run);
    const empty = {
      ...found,
      papers: [
        ...found.papers,
        { pmcid: "PMC9", title: "Title of PMC9", references: [] },
      ],
    };
    expect(renderFound(foundSchema.parse(empty))).not.toContain("PMC9");
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

// The markup of the element whose start tag carries `attribute`, through its
// matching end tag, or "" when no element carries it.
const elementWith = (html: string, attribute: string) => {
  const from = html.indexOf(attribute);
  if (from < 0) return "";
  const at = html.lastIndexOf("<", from);
  const name = /^<(\w+)/u.exec(html.slice(at))?.[1] ?? "";
  let depth = 0;
  for (const tag of html
    .slice(at)
    .matchAll(new RegExp(`<(/?)${name}\\b[^>]*>`, "gu"))) {
    depth += tag[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(at, at + tag.index + tag[0].length);
  }
  return "";
};

// The list runs to about 1,000 rows, so the page splits into two tabs, and
// How it's run is one click from the top (#674). The page runs no script
// (no-tracking.md): each tab links to its panel, and the stylesheet shows
// the panel the address names.
describe("the page's two tabs (#674)", () => {
  const pages = {
    "before any run": template,
    "after a run": buildPage(template, summarise(rows, run)),
  };

  for (const [when, page] of Object.entries(pages)) {
    describe(when, () => {
      const found = elementWith(page, 'id="what-it-found"');
      const how = elementWith(page, 'id="how-its-run"');

      it("links a tab to each panel, above both", () => {
        const tabs = elementWith(page, 'class="tabs"');
        expect(tabs).toMatch(/^<nav\b/u);
        expect(tabs).toContain('href="#what-it-found"');
        expect(tabs).toContain('href="#how-its-run"');
        expect(page.indexOf(tabs)).toBeLessThan(page.indexOf(found));
        expect(page.indexOf(found)).toBeLessThan(page.indexOf(how));
      });

      it("holds the findings in one panel and the release in the other", () => {
        expect(found).toMatch(/^<div class="panel" /u);
        expect(how).toMatch(/^<div class="panel" /u);
        expect(found).toContain("<!-- found -->");
        expect(found).toContain("<!-- /found -->");
        expect(how).toContain("<!-- run -->");
        expect(how).toContain("<!-- /run -->");
      });

      it("keeps the notice, the contact and the no-warranty line under both tabs", () => {
        expect(found).not.toBe("");
        expect(how).not.toBe("");
        const outside = page.replace(found, "").replace(how, "");
        expect(textOf(footerOf(outside))).toMatch(NOTICE);
        expect(footerOf(outside)).toContain(`mailto:${CONTACT}`);
        expect(outside.replace(/\s+/gu, " ")).toMatch(
          /proposed by software\. Each shows its status, and none comes with a warranty/u,
        );
      });
    });
  }

  it("lists the references last in What it found, below the counts, formats and papers not yet read", () => {
    const html = renderFound(summarise(rows, run));
    const list = html.indexOf('<table class="references">');
    expect(list).toBeGreaterThan(html.indexOf('class="cards"'));
    expect(list).toBeGreaterThan(html.indexOf('<table class="formats">'));
    expect(list).toBeGreaterThan(html.indexOf('<ul class="pending">'));
    expect(list).toBeGreaterThan(html.lastIndexOf("<h3>"));
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

  // The page shows each reference in its normal form, as gold set B stores
  // it. found.json and the table keep the text the paper printed (#606).
  it("shows each reference in its normal form, not as the paper spaced it (#606)", () => {
    const spaced = [
      { asWritten: "C18281 /A19169", normalised: "C18281/A19169" },
      { asWritten: "C1287/A 10710", normalised: "C1287/A10710" },
      { asWritten: "C45074 / A26553", normalised: "C45074/A26553" },
      { asWritten: "CTRQQR-2021\\100012", normalised: "CTRQQR-2021/100012" },
      { asWritten: "PPRPGM-Nov20∖100002", normalised: "PPRPGM-NOV20/100002" },
      { asWritten: "C1234\u2212A5", normalised: "C1234-A5" },
    ].map((reference) => ({ ...reference, format: "Cn/An" }));
    const published = summarise([done("PMC9", spaced)], run);
    expect(published.papers[0]?.references.map((r) => r.asWritten)).toEqual(
      spaced.map((r) => r.asWritten),
    );
    const html = renderFound(published);
    expect(html).toContain(
      `>${spaced.map((r) => r.normalised).join("<br>")}</td>`,
    );
    for (const { asWritten } of spaced) {
      expect(html).not.toContain(asWritten);
    }
    expect(html).not.toContain("as written");
  });

  describe("a title with inline markup (#606)", () => {
    const shown = (title: string) =>
      /<a href="[^"]*">([\s\S]*?)<\/a>/u.exec(
        renderFound(summarise([{ ...done("PMC9", [ca]), title }], run)),
      )?.[1];

    it("shows sup, sub, i and b as formatting, not as text", () => {
      expect(shown("[<sup>18</sup>F]fluoromethyl and H<sub>2</sub>O")).toBe(
        "[<sup>18</sup>F]fluoromethyl and H<sub>2</sub>O",
      );
      expect(shown("<i>BRCA1</i> in <b>mice</b>")).toBe(
        "<i>BRCA1</i> in <b>mice</b>",
      );
      expect(shown("<I>Upper</I> case")).toBe("<i>Upper</i> case");
    });

    it("nests the tags it shows, and drops any left without its pair, as plainTitle does (#639)", () => {
      expect(shown("<i>a <sup>b</sup> c</i>")).toBe("<i>a <sup>b</sup> c</i>");
      expect(shown("<i>open <b>both")).toBe("open both");
      expect(shown("<i>a <b>b</i> c</b>")).toBe("a <b>b c</b>");
    });

    it("drops a closing tag with nothing open, rather than show it", () => {
      expect(shown("a</sup> b")).toBe("a b");
    });

    it("links by the pmcid when the markup leaves no text to show", () => {
      expect(shown("<i></i>")).toBe("PMC9");
      expect(shown("</sup> ")).toBe("PMC9");
    });

    it("escapes any other markup, and a tag that carries attributes", () => {
      expect(shown('<sup onclick="x">1</sup>')).toBe(
        "&lt;sup onclick=&quot;x&quot;&gt;1",
      );
      expect(shown("<script>alert(1)</script> <a>b</a>")).toBe(
        "&lt;script&gt;alert(1)&lt;/script&gt; &lt;a&gt;b&lt;/a&gt;",
      );
      expect(shown("<sup>a & b</sup> <5 > 3")).toBe(
        "<sup>a &amp; b</sup> &lt;5 &gt; 3",
      );
    });

    it("shows the markup the same way in the list of papers not yet read", () => {
      const html = renderFound(
        summarise([row("PMC8", { title: "H<sub>2</sub>O" })], run),
      );
      expect(html).toContain(">H<sub>2</sub>O</a></li>");
    });
  });

  it("counts the papers as a gap in linking, not a failure (#588)", () => {
    const html = renderFound(summarise(rows, run));
    expect(html).toContain(
      "papers that name Cancer Research UK as a funder but are not yet linked to one of its grants in Europe PMC",
    );
    expect(html).not.toContain("linked to none of its grants");
  });

  it("says what each reference format means, including a bare number", () => {
    const html = renderFound(summarise(rows, run));
    expect(html).toContain("Cn/An is the older");
    expect(html).toContain("and n a bare award");
    // A bare number may come from the text alone where it ties the number
    // to the funder (#506).
    expect(html).toContain("that the funding text ties to the funder");
    expect(html).toContain("CRUK-X a form that");
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

describe("the papers not yet read in the counts (#724)", () => {
  const cards = (html: string) =>
    [...html.matchAll(/<p class="card stat">(.*?)<\/p>/gu)].map(
      (match) => match[1] ?? "",
    );
  const read = (html: string) =>
    cards(html).find((card) => card.includes("papers read")) ?? "";

  it("are counted in the papers read card, not in a card of their own", () => {
    const html = renderFound(summarise(rows, run));
    expect(cards(html)).toHaveLength(4);
    expect(cards(html).join("\n")).not.toContain("papers not yet read");
    expect(read(html)).toContain('<span class="more">1 not yet read</span>');
  });

  it("go unmentioned in that card when every paper has been read", () => {
    const html = renderFound(
      summarise(
        rows.filter((r) => r.status === "processed"),
        run,
      ),
    );
    expect(read(html)).toContain("papers read");
    expect(read(html)).not.toContain("not yet read");
  });
});

describe("a paper Europe PMC marks as retracted (#587)", () => {
  const found = summarise(rows, run);

  it("leaves the paper out of the list and the counts", () => {
    const left = leaveOut(found, new Set(["PMC1"]));
    expect(left.papers.map((paper) => paper.pmcid)).toEqual(["PMC2"]);
    expect(left.counts).toEqual({
      papers: 3,
      processed: 2,
      withReference: 1,
      references: 1,
      pending: 1,
    });
    expect(left.formats).toEqual([{ format: "Cn/An", count: 1 }]);
  });

  it("leaves a paper not yet read out of the list and the counts", () => {
    const left = leaveOut(found, new Set(["PMC4"]));
    expect(left.pending).toEqual([]);
    expect(left.counts).toEqual({ ...found.counts, papers: 3, pending: 0 });
  });

  it("changes nothing when no paper listed is retracted", () => {
    expect(leaveOut(found, new Set(["PMC9"]))).toEqual(found);
  });

  // The run's search leaves retracted papers out, but the deploy builds the
  // page from the last run's found.json, which can still hold one.
  it("leaves a retracted paper out when the deploy builds the page again", () => {
    const [pmcid = ""] = retracted;
    const data = summarise([...rows, done(pmcid, [an])], run);
    const html = rebuild(template, JSON.stringify(data), null);
    expect(html).not.toContain(pmcid);
    expect(html).toBe(buildPage(template, summarise(rows, run)));
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
