import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findReferences } from "../extract/rules.ts";
import { elements, FUNDING_FOOTNOTE, fundingSections } from "./jats.ts";

const fixture = (pmcid: string) =>
  readFileSync(
    new URL(`../../test/fixtures/europepmc/${pmcid}.xml`, import.meta.url),
    "utf8",
  );

describe("cutting a paper to its funding sections", () => {
  const sections = fundingSections(fixture("PMC0000001"));

  it("keeps the funding statement, the acknowledgements and the disclosures", () => {
    expect(sections.text).toEqual([
      "Morwenna Quillfeather is funded by Cancer Research UK (C1234/A56789).",
      "We thank Tobias Wrenfield-Oakes for help. This work was supported by Cancer Research UK grant CTRQQR-2021\\100010 and by CRUK award A28707.",
      "The Example Trust funded grant A12345.",
    ]);
  });

  it("keeps the funding metadata", () => {
    expect(sections.awards).toEqual([
      { sources: ["Cancer Research UK"], ids: ["C1234/A56789"] },
    ]);
  });

  // An award group can name several funders. Where an award id names its
  // funder through rid, the id goes to that funder alone (#128).
  const shared = (ids: string) =>
    `<article><front><article-meta><funding-group><award-group>` +
    `<funding-source id="fs1">Cancer Research UK</funding-source>` +
    `<funding-source id="fs2"><institution-wrap><institution>Example Trust</institution></institution-wrap></funding-source>` +
    ids +
    `</award-group></funding-group></article-meta></front>` +
    `<back><ack><p>Funded by grant 12345 and grant 67890.</p></ack></back></article>`;

  it("gives an award id to the funding source its rid names", () => {
    expect(
      fundingSections(
        shared(
          `<award-id rid="fs2">12345</award-id><award-id rid="fs1">67890</award-id>`,
        ),
      ).awards,
    ).toEqual([
      { sources: ["Example Trust"], ids: ["12345"] },
      { sources: ["Cancer Research UK"], ids: ["67890"] },
    ]);
  });

  it("reads a rid written in single quotes", () => {
    expect(
      fundingSections(
        shared(
          `<award-id rid='fs2'>12345</award-id><award-id rid='fs1'>67890</award-id>`,
        ),
      ).awards,
    ).toEqual([
      { sources: ["Example Trust"], ids: ["12345"] },
      { sources: ["Cancer Research UK"], ids: ["67890"] },
    ]);
  });

  it("reads the award id after a self-closing one with its own rid (#195)", () => {
    expect(
      fundingSections(
        shared(`<award-id rid="fs2"/><award-id rid="fs1">67890</award-id>`),
      ).awards,
    ).toEqual([{ sources: ["Cancer Research UK"], ids: ["67890"] }]);
  });

  it("gives an award id with no rid to every source in its group", () => {
    expect(
      fundingSections(
        shared(
          `<award-id>12345</award-id><award-id rid="fs1">67890</award-id>`,
        ),
      ).awards,
    ).toEqual([
      { sources: ["Cancer Research UK", "Example Trust"], ids: ["12345"] },
      { sources: ["Cancer Research UK"], ids: ["67890"] },
    ]);
  });

  it("gives an award id whose rid names no source in its group to every source", () => {
    expect(
      fundingSections(shared(`<award-id rid="other">12345</award-id>`)).awards,
    ).toEqual([
      { sources: ["Cancer Research UK", "Example Trust"], ids: ["12345"] },
    ]);
  });

  it("keeps an award group with no award id", () => {
    expect(fundingSections(shared("")).awards).toEqual([
      { sources: ["Cancer Research UK", "Example Trust"], ids: [] },
    ]);
  });

  it("reads only the bare number a shared award group ties to the funder", () => {
    expect(
      findReferences(
        fundingSections(
          shared(
            `<award-id rid="fs2">12345</award-id><award-id rid="fs1">67890</award-id>`,
          ),
        ),
      ).map((reference) => reference.normalised),
    ).toEqual(["67890"]);
  });

  it("drops the abstract, the body and the author list", () => {
    const kept = JSON.stringify(sections);
    expect(kept).not.toContain("abstract");
    expect(kept).not.toContain("Body text");
    expect(kept).not.toContain("Results");
  });

  it("keeps a funding section in the body, and decodes entities", () => {
    expect(fundingSections(fixture("PMC0000002")).text).toEqual([
      "Isolde Brackenridge holds a Cancer Research UK fellowship (RRCOER-Jun24/100008).",
      "We thank Cancer Research UK for its support.",
    ]);
    expect(fundingSections(fixture("PMC0000003")).text).toEqual([
      "Ezekiel Thornbury-Vale thanks Cancer Research UK & the Example Trust.",
    ]);
  });

  describe("keeps acknowledgements marked up as a body section", () => {
    const paper = (section: string) =>
      `<article><front><article-meta><contrib-group><contrib><name><surname>Authorname</surname></name></contrib></contrib-group><abstract><p>The abstract.</p></abstract></article-meta></front><body><sec><title>Results</title><p>Body text.</p></sec>${section}</body></article>`;

    it.each([
      ['<sec sec-type="ack"><title>Thanks</title><p>Grant A1.</p></sec>'],
      ['<sec sec-type="acknowledgments"><p>Grant A1.</p></sec>'],
      ["<sec><title>Acknowledgements</title><p>Grant A1.</p></sec>"],
      ["<sec><title>Acknowledgments</title><p>Grant A1.</p></sec>"],
      [
        "<sec><label>5.</label><title>ACKNOWLEDGEMENTS</title><p>Grant A1.</p></sec>",
      ],
      ["<sec><title>Support</title><p>Grant A1.</p></sec>"],
      [
        "<sec><sec-meta><kwd-group><kwd>k</kwd></kwd-group></sec-meta><title>Funding</title><p>Grant A1.</p></sec>",
      ],
      [
        "<sec><sec-meta><contrib-group><contrib><name><surname>Authorname</surname></name></contrib></contrib-group></sec-meta><label>5.</label><title>Acknowledgements</title><p>Grant A1.</p></sec>",
      ],
      ["<sec><sec-meta/><title>Funding</title><p>Grant A1.</p></sec>"],
      [
        '<sec sec-type="funding"><sec-meta><contrib-group><contrib><name><surname>Authorname</surname></name></contrib></contrib-group></sec-meta><title>Funding</title>Grant A1.</sec>',
      ],
      [
        '<sec sec-type="ack"><sec-meta><contrib-group><contrib><bio><p>Authorname</p></bio></contrib></contrib-group></sec-meta><p>Grant A1.</p></sec>',
      ],
    ])("in %s", (section) => {
      const sections = fundingSections(paper(section));
      expect(sections.text).toEqual(["Grant A1."]);
      const kept = JSON.stringify(sections);
      expect(kept).not.toContain("abstract");
      expect(kept).not.toContain("Body text");
      expect(kept).not.toContain("Authorname");
    });

    it("but not a section whose title only starts with Support", () => {
      expect(
        fundingSections(
          paper(
            "<sec><title>Supporting information</title><p>Table S1.</p></sec>",
          ),
        ).text,
      ).toEqual([]);
    });

    it("nor a section whose sec-meta is followed by another title", () => {
      expect(
        fundingSections(
          paper(
            "<sec><sec-meta><kwd-group><kwd>Funding</kwd></kwd-group></sec-meta><title>Methods</title><p>Method.</p></sec>",
          ),
        ).text,
      ).toEqual([]);
    });

    it.each([
      ["<sec><title>Support vector machines</title><p>Method.</p></sec>"],
      ["<sec><title>Support needs of carers</title><p>Method.</p></sec>"],
    ])("nor a body section whose title goes on past Support, %s", (section) => {
      expect(fundingSections(paper(section)).text).toEqual([]);
    });

    // A section's body runs to the closing tag that balances its opening
    // tag, not to the first closing tag of a subsection (#189).
    it.each([
      [
        '<sec sec-type="ack"><title>Acknowledgements</title><sec><title>Author contributions</title><p>Made-up text.</p></sec><p>Grant A1.</p></sec>',
      ],
      [
        "<sec><title>Funding</title><sec><title>First</title><p>Made-up text.</p></sec><sec/><p>Grant A1.</p></sec>",
      ],
      [
        '<sec sec-type="funding"><sec><sec><p>Made-up text.</p></sec></sec><p>Grant A1.</p></sec>',
      ],
      [
        '<SEC sec-type="funding"><SEC><p>Made-up text.</p></SEC><p>Grant A1.</p></SEC>',
      ],
    ])("keeps the paragraphs after a subsection in %s", (section) => {
      const sections = fundingSections(
        paper(
          `${section}<sec><title>Discussion</title><p>Body text.</p></sec>`,
        ),
      );
      expect(sections.text).toEqual(["Made-up text.", "Grant A1."]);
      const kept = JSON.stringify(sections);
      expect(kept).not.toContain("abstract");
      expect(kept).not.toContain("Body text");
      expect(kept).not.toContain("Authorname");
    });

    it("runs a funding section with no closing tag only to the next closing tag", () => {
      const sections = fundingSections(
        paper(
          '<sec sec-type="funding"><sec><p>Grant A1.</p></sec><sec><title>Discussion</title><p>Body text.</p></sec>',
        ),
      );
      expect(sections.text).toEqual(["Grant A1."]);
    });
  });

  it("reads a paragraph that holds a list of paragraphs whole", () => {
    expect(
      fundingSections(
        "<article><back><ack><p>Supported by <list><list-item><p>grant A1</p></list-item><list-item><p>grant B2</p></list-item></list> and grant A2.</p><p>Thanks to Example Lab.</p></ack></back></article>",
      ).text,
    ).toEqual([
      "Supported by grant A1 grant B2 and grant A2.",
      "Thanks to Example Lab.",
    ]);
  });

  it("reads past a paragraph tag in a comment or a CDATA section", () => {
    expect(
      fundingSections(
        "<article><back><ack><p>Grant A1<!-- was <p> -->.</p><p>Grant <![CDATA[<p>]]>B2.</p><p>Grant A2.</p></ack></back></article>",
      ).text,
    ).toEqual(["Grant A1.", "Grant <p>B2.", "Grant A2."]);
  });

  it("runs an unbalanced funding section to the next closing tag with white space before its > (#217)", () => {
    expect(
      fundingSections(
        '<article><body><sec sec-type="funding"><p>Grant A1.</p><sec><title>Sub</title></sec ><p>Body text.</p></body></article>',
      ).text,
    ).toEqual(["Grant A1."]);
  });

  it("keeps a paragraph whose closing tag is missing", () => {
    expect(
      fundingSections(
        "<article><back><ack><p>Grant A1.</p><p>Grant B2 <p>and A2.</p></ack></back></article>",
      ).text,
    ).toEqual(["Grant A1.", "Grant B2 and A2."]);
  });

  it("keeps no more of a paper after an unclosed element than the next closing tag", () => {
    const sections = fundingSections(
      "<article><back><ack><p>Grant A1.</p><ref-list><ref>Refauthor 2020.</ref></ref-list></back><fn-group><fn><p>Note.</p></fn></fn-group></article>",
    );
    expect(sections.text).toEqual([]);
    expect(JSON.stringify(sections)).not.toContain("Refauthor");
  });

  it("does not read a footnote group as a footnote", () => {
    expect(
      fundingSections(
        '<article><back><fn-group fn-type="funding"><fn><p>Grant A1.</p></fn><p>Notes.</p></fn-group></back></article>',
      ).text,
    ).toEqual([]);
  });

  it("leaves a character reference past Unicode's range as written", () => {
    expect(
      fundingSections(
        "<article><back><ack><p>Grant &#x110000; and &#99999999;.</p></ack></back></article>",
      ).text,
    ).toEqual(["Grant &#x110000; and &#99999999;."]);
  });

  it("reads an empty self-closing award id as no id, and the next one alone (#195)", () => {
    const award = (inside: string) =>
      fundingSections(
        `<article><front><funding-group><award-group>${inside}</award-group></funding-group></front></article>`,
      ).awards;
    expect(
      award(
        `<funding-source>Cancer Research UK</funding-source><award-id/><award-id rid="x"/><award-id>A1</award-id>`,
      ),
    ).toEqual([{ sources: ["Cancer Research UK"], ids: ["A1"] }]);
    expect(
      award(
        `<award-id /><funding-source>Cancer Research UK</funding-source><award-id>A1</award-id><award-id></award-id>`,
      ),
    ).toEqual([{ sources: ["Cancer Research UK"], ids: ["A1"] }]);
  });

  it("reads a self-closing element of any kind as empty", () => {
    expect(
      fundingSections(
        `<article><back><ack/><p>Body text.</p><ack><p>Thanks.</p></ack></back></article>`,
      ).text,
    ).toEqual(["Thanks."]);
  });

  it("keeps a section's whole text when its only paragraph is self-closing", () => {
    expect(
      fundingSections(
        `<article><back><ack><title>Acknowledgements</title><p/>Funded by grant A1.</ack></back></article>`,
      ).text,
    ).toEqual(["Funded by grant A1."]);
  });

  it("keeps no award for a self-closing award group", () => {
    expect(
      fundingSections(
        `<article><front><funding-group><award-group/></funding-group></front></article>`,
      ),
    ).toEqual({ text: [], awards: [] });
  });

  it("takes no self-closing section for a funding section (#221)", () => {
    expect(
      fundingSections(
        `<article><body><sec sec-type="funding"/><sec><title>Results</title><p>Body text.</p></sec></body></article>`,
      ).text,
    ).toEqual([]);
  });

  it("takes no self-closing section for one titled as funding by the title after it (#221)", () => {
    expect(
      fundingSections(
        `<article><body><sec><sec/><title>Funding sources compared</title><p>Body text.</p></sec></body></article>`,
      ).text,
    ).toEqual([]);
  });

  it("strips a self-closing title and nothing after it (#221)", () => {
    expect(
      fundingSections(
        `<article><back><ack><title/>Funded by grant A1.<sec><title>X</title></sec></ack></back></article>`,
      ).text,
    ).toEqual(["Funded by grant A1."]);
  });

  describe("matches a section, label or title tag only by its whole name (#216)", () => {
    it.each([
      [
        "<sec-meta><title>Funding</title><p>Grant A1.</p></sec-meta><sec><title>Results</title><p>Body text.</p></sec>",
      ],
      ["<sec><title-group>Funding</title-group><p>Grant A1.</p></sec>"],
      [
        "<sec><label-group>5.</label><title>Funding</title><p>Grant A1.</p></sec>",
      ],
    ])("finds no funding section in %s", (body) => {
      expect(
        fundingSections(`<article><body>${body}</body></article>`).text,
      ).toEqual([]);
    });

    it("strips only a title, not a tag whose name begins with title", () => {
      expect(
        fundingSections(
          `<article><back><ack><title-group>Funded by grant A1.</title-group><title>Thanks</title></ack></back></article>`,
        ).text,
      ).toEqual(["Funded by grant A1."]);
    });
  });

  it("finds nothing in a paper with no funding sections", () => {
    expect(fundingSections("<article><body><p>x</p></body></article>")).toEqual(
      { text: [], awards: [] },
    );
  });
});

describe("reading an element by its name", () => {
  it("matches only the whole name, not a longer name it begins", () => {
    const xml =
      '<fn-group><fn id="a"><p>one</p></fn></fn-group><award-group><award>two</award></award-group>';
    expect(elements(xml, "fn")).toEqual(["<p>one</p>"]);
    expect(elements(xml, "award")).toEqual(["two"]);
  });

  it("matches an element with no attributes or with whitespace after its name", () => {
    expect(elements("<fn>a</fn><fn\n>b</fn>", "fn")).toEqual(["a", "b"]);
  });

  it("reads a self-closing element by its whole name too", () => {
    expect(elements("<fn-group/><fn/><fn>x</fn>", "fn")).toEqual(["", "x"]);
  });

  // XML allows white space before a closing tag's > (#217).
  it("ends an element at a closing tag with white space before its >", () => {
    expect(elements("<fn>a</fn ><fn>b</fn\n>", "fn")).toEqual(["a", "b"]);
  });

  it("ends an unbalanced element at the next closing tag with white space before its >", () => {
    expect(elements("<fn>a<fn>b</fn >c<fn>d</fn>", "fn")).toEqual([
      "a<fn>b",
      "d",
    ]);
  });
  it("reads a name with a regular expression character as written (#217)", () => {
    expect(elements("<aXb>x</aXb><a.b>y</a.b ><a.b>z<a.b/>", "a.b")).toEqual([
      "y",
    ]);
  });
});

describe("reading an element by an attribute (#217)", () => {
  const footnotes = (xml: string) => elements(xml, "fn", FUNDING_FOOTNOTE);

  it.each([
    ['<fn fn-type="funding">a</fn>'],
    ['<fn id="n1" fn-type="supported-by">a</fn>'],
    ["<fn fn-type='financial-disclosure'>a</fn>"],
    ['<fn\nfn-type = "funding">a</fn>'],
  ])("reads the whole attribute in %s", (xml) => {
    expect(footnotes(xml)).toEqual(["a"]);
  });

  it.each([
    ['<fn xfn-type="funding">a</fn>'],
    ['<fn x-fn-type="funding">a</fn>'],
    ['<fn fn-type="other">a</fn>'],
    [`<fn title='fn-type="funding"'>a</fn>`],
    ["<fn title=\"x fn-type='funding'\">a</fn>"],
  ])("does not read an attribute look-alike in %s", (xml) => {
    expect(footnotes(xml)).toEqual([]);
  });
});
