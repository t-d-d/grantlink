import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findReferences } from "../extract/rules.ts";
import {
  FUNDING_TITLES,
  fundingSections,
  isSecMetaName,
  normaliseTitle,
} from "./jats.ts";

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

  // A principal award recipient or investigator names people, and the cutter
  // reads neither. No recorded fixture keeps one any more (#275), so this is
  // where a change that read one would show.
  it("drops an award group's principal award recipient and investigator (#275)", () => {
    const kept = JSON.stringify(
      fundingSections(
        shared(
          `<award-id rid="fs1">67890</award-id>` +
            `<principal-award-recipient><name><surname>Harrowgate</surname></name></principal-award-recipient>` +
            `<principal-investigator><name><surname>Fenwhistle</surname></name></principal-investigator>`,
        ),
      ),
    );
    expect(kept).toContain("67890");
    expect(kept).not.toContain("Harrowgate");
    expect(kept).not.toContain("Fenwhistle");
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
      ["<sec><title>Role of the funder/sponsor</title><p>Grant A1.</p></sec>"],
      [
        "<sec><title>Role of the funder / sponsor</title><p>Grant A1.</p></sec>",
      ],
      [
        "<sec><title>Acknowledgements &amp; Funding</title><p>Grant A1.</p></sec>",
      ],
      // The joined headings take either spelling, as the single words do.
      ["<sec><title>Acknowledgments and Funding</title><p>Grant A1.</p></sec>"],
      ["<sec><title>Funding and Acknowledgments</title><p>Grant A1.</p></sec>"],
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
      // A comment or a processing instruction between the tags that open a
      // section does not hide it (#230).
      ["<sec><!-- x --><title>Funding</title><p>Grant A1.</p></sec>"],
      ["<sec><?pi x?><title>Funding</title><p>Grant A1.</p></sec>"],
      [
        "<sec><label>5.</label><?pi x?><!-- x --><title>Acknowledgements</title><p>Grant A1.</p></sec>",
      ],
      [
        '<sec sec-type="funding"><?pi x?><sec-meta><contrib-group><contrib><name><surname>Authorname</surname></name></contrib></contrib-group></sec-meta><?pi x?><title>Funding</title>Grant A1.</sec>',
      ],
      // Nor does one inside the title, before the words that name it.
      ["<sec><title><?pi x?>Funding</title><p>Grant A1.</p></sec>"],
      ["<sec><title><?pi x?>Support</title><p>Grant A1.</p></sec>"],
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

    it("nor a body section whose comment holds another section's title", () => {
      expect(
        fundingSections(
          paper(
            "<sec><!-- a --><title>Methods</title><p>Method.</p><!-- b --><title>Funding</title></sec>",
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

    // A title counts only when the whole of it, normalised, is a heading on
    // the list, so a body section whose title only begins with a funding
    // word is not kept (#239).
    it.each([
      ["Funding models for new drugs"],
      ["Funding sources in oncology"],
      ["Acknowledgements of uncertainty"],
      ["Financial support for patients"],
      ["Grant support systems"],
    ])("nor a body section titled %s", (title) => {
      expect(
        fundingSections(
          `<body><sec><title>${title}</title><p>Body of the paper.</p></sec></body>`,
        ).text,
      ).toEqual([]);
    });

    // The headings #239 names. Gold sets A and B add their own to the list.
    const HEADINGS = [
      "funding",
      "funding information",
      "funding statement",
      "funding sources",
      "source of funding",
      "sources of funding",
      "role of the funding source",
      "financial support",
      "grant support",
      "support",
      "acknowledgement",
      "acknowledgements",
      "acknowledgment",
      "acknowledgments",
      "acknowledgements and funding",
      "funding and acknowledgements",
      "acknowledgments and funding",
      "funding and acknowledgments",
      "funding source",
      "financial support and sponsorship",
      "funding sources and disclosures",
      "acknowledgements and disclosures",
      "acknowledgments and disclosures",
    ];

    it("lists each heading #239 names, in normal form", () => {
      for (const heading of HEADINGS) {
        expect(FUNDING_TITLES.has(heading)).toBe(true);
      }
      for (const heading of FUNDING_TITLES) {
        expect(normaliseTitle(heading)).toBe(heading);
      }
    });

    const title = (words: string) =>
      words.replace(/\b\w/gu, (letter) => letter.toUpperCase());
    const variants = (heading: string) => [
      heading,
      heading.toUpperCase(),
      `${title(heading)}:`,
      `${title(heading)}.`,
      ` ${heading.replaceAll(" ", "  ")} `,
      heading.replaceAll(" ", " "),
      `${heading.replaceAll(" ", "&#160;")}&#x2014;`,
      `(${heading})`,
      // Words joined by a slash, with and without spaces, and "&" for "and".
      heading.replaceAll(" ", "/"),
      heading.replaceAll(" ", " / "),
      heading.replaceAll(" and ", " &amp; "),
      heading.replaceAll(" and ", "&amp;"),
    ];

    it.each([...new Set([...HEADINGS, ...FUNDING_TITLES])])(
      "and keeps a section titled %s, whatever its case, punctuation and spacing",
      (heading) => {
        for (const written of variants(heading)) {
          expect(
            fundingSections(
              paper(`<sec><title>${written}</title><p>Grant A1.</p></sec>`),
            ).text,
            written,
          ).toEqual(["Grant A1."]);
        }
      },
    );

    // A section's body runs to the closing tag that balances its opening
    // tag, not to the first closing tag of a subsection (#189). Each
    // subsection here is untitled or a funding section, so the cut keeps it
    // (#563).
    it.each([
      [
        '<sec sec-type="ack"><title>Acknowledgements</title><sec><title>Funding</title><p>Made-up text.</p></sec><p>Grant A1.</p></sec>',
      ],
      [
        "<sec><title>Funding</title><sec><title>Grants</title><p>Made-up text.</p></sec><sec/><p>Grant A1.</p></sec>",
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

    // When a paper's section tags do not balance, which closing tag is
    // missing cannot be told, so a funding section holds no section: it runs
    // only to the next section tag, opening or closing (#263). A subsection
    // of it is then lost, as here, since it cannot be told apart from a body
    // section after it.
    it("runs a funding section with no closing tag only to the next section tag", () => {
      const sections = fundingSections(
        paper(
          '<sec sec-type="funding"><sec><p>Grant A1.</p></sec><sec><title>Discussion</title><p>Body text.</p></sec>',
        ),
      );
      expect(sections.text).toEqual([]);
      expect(JSON.stringify(sections)).not.toContain("Body text");
    });

    it.each([
      // A funding section never closed, with a body section after it.
      [
        '<sec sec-type="funding"><p>Grant A1.</p><sec><title>Discussion</title><p>Body text.</p></sec>',
      ],
      // A funding section in a parent section, with a subsection never
      // closed, so its parent's closing tag would balance it.
      [
        '<sec><title>Back</title><sec sec-type="funding"><p>Grant A1.</p><sec><p>Sub.</p></sec><p>Body text.</p></sec>',
      ],
      // A closing tag too many, before the funding section.
      [
        '</sec><sec><title>Back</title><sec sec-type="funding"><p>Grant A1.</p><sec><p>Sub.</p></sec><p>Body text.</p></sec>',
      ],
    ])(
      "keeps no text from outside an unbalanced funding section in %s (#263)",
      (section) => {
        const sections = fundingSections(paper(section));
        expect(sections.text).toEqual(["Grant A1."]);
        const kept = JSON.stringify(sections);
        expect(kept).not.toContain("Body text");
        expect(kept).not.toContain("Sub.");
      },
    );

    it.each([
      // A body section never closed, before the back matter.
      [
        '<article><body><sec><p>Body text.</p></body><back><sec sec-type="funding"><sec><title>Grants</title><p>Grant A1.</p></sec><p>Grant C2.</p></sec></back></article>',
      ],
      // A body section never closed, after the funding section.
      [
        '<article><body><sec sec-type="funding"><sec><title>Grants</title><p>Grant A1.</p></sec><p>Grant C2.</p></sec><sec><p>Body text.</p></body></article>',
      ],
    ])(
      "keeps a well-formed funding section whole when a section elsewhere is never closed, in %s (#263)",
      (xml) => {
        const sections = fundingSections(xml);
        expect(sections.text).toEqual(["Grant A1.", "Grant C2."]);
        expect(JSON.stringify(sections)).not.toContain("Body text");
      },
    );

    it("still keeps a funding section's subsections when every section tag balances", () => {
      expect(
        fundingSections(
          paper(
            '<sec><title>Back</title><sec sec-type="funding"><p>Grant A1.</p><sec><p>Sub.</p></sec></sec><p>Body text.</p></sec>',
          ),
        ).text,
      ).toEqual(["Grant A1.", "Sub."]);
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

  // Which paragraph's closing tag is missing cannot be told, so the
  // unclosed one ends at the next paragraph tag (#263).
  it("keeps a paragraph whose closing tag is missing", () => {
    expect(
      fundingSections(
        "<article><back><ack><p>Grant A1.</p><p>Grant B2 <p>and A2.</p></ack></back></article>",
      ).text,
    ).toEqual(["Grant A1.", "Grant B2", "and A2."]);
  });

  it("keeps no text from a footnote after an unclosed funding footnote (#263)", () => {
    const sections = fundingSections(
      '<article><back><fn-group><fn fn-type="funding"><p>Grant A1.</p><fn><p>Body text.</p></fn></fn-group></back></article>',
    );
    expect(sections.text).toEqual(["Grant A1."]);
    expect(JSON.stringify(sections)).not.toContain("Body text");
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

  it("takes a section with a self-closing label before its funding title (#227)", () => {
    expect(
      fundingSections(
        `<article><body><sec><label/><title>Funding</title><p>Grant A1.</p></sec></body></article>`,
      ).text,
    ).toEqual(["Grant A1."]);
  });

  it.each([
    ["label", "<label/>", "<label>2</label>"],
    ["sec-meta", "<sec-meta/>", "<sec-meta><kwd>k</kwd></sec-meta>"],
  ])(
    "does not run a self-closing %s on to a later section's (#227)",
    (_name, empty, full) => {
      const xml = `<sec>${empty}<title>Methods</title><p>Body text.</p></sec><sec>${full}<title>Funding</title><p>Grant A1.</p></sec>`;
      const sections = fundingSections(
        `<article><body>${xml}</body></article>`,
      );
      expect(sections.text).toEqual(["Grant A1."]);
      expect(JSON.stringify(sections)).not.toContain("Body text");
    },
  );

  // A <sec-meta> can name people, so the cutter keeps none of its text,
  // wherever in a funding part it stands (#229).
  it.each([
    [
      "<ack><sec><sec-meta><contrib-group><contrib><bio><p>Authorname.</p></bio></contrib></contrib-group></sec-meta><title>Funding</title><p>Grant A1.</p></sec></ack>",
    ],
    [
      "<ack><sec><sec-meta><contrib-group><contrib><bio><p>Authorname.</p></bio></contrib></contrib-group></sec-meta><title>Thanks</title><p>Grant A1.</p></sec></ack>",
    ],
    [
      "<ack><sec-meta><contrib-group><contrib><bio><p>Authorname.</p></bio></contrib></contrib-group></sec-meta><p>Grant A1.</p></ack>",
    ],
    [
      "<ack><sec><SEC-META><bio>Authorname.</bio></SEC-META><title>Thanks</title>Grant A1.</sec></ack>",
    ],
    [
      '<sec sec-type="funding"><title>Funding</title><sec><sec-meta><contrib-group><contrib><bio><p>Authorname.</p></bio></contrib></contrib-group></sec-meta><title>Grant support</title><p>Grant A1.</p></sec></sec>',
    ],
    ["<ack><sec><sec-meta/><title>Thanks</title><p>Grant A1.</p></sec></ack>"],
    // Inside a paragraph, at any depth and in any case (#416).
    ["<ack><p>Grant A1.<sec-meta><bio>Authorname.</bio></sec-meta></p></ack>"],
    [
      '<sec sec-type="funding"><p>Grant A1.<bold><italic><sec-meta>Authorname.</sec-meta></italic></bold></p></sec>',
    ],
    [
      '<fn-group><fn fn-type="funding"><p>Grant A1.<SEC-META>Authorname.</SEC-META></p></fn></fn-group>',
    ],
  ])("keeps no text from a sec-meta inside a funding part, in %s", (part) => {
    const sections = fundingSections(`<article><back>${part}</back></article>`);
    expect(sections.text).toEqual(["Grant A1."]);
    expect(JSON.stringify(sections)).not.toContain("Authorname");
  });

  it("keeps no text after a sec-meta that is never closed (#229)", () => {
    const sections = fundingSections(
      `<article><back><ack><p>Grant A1.</p><sec-meta><contrib-group><contrib><bio><p>Authorname.</p></bio></contrib></contrib-group><p>Grant B2.</p></ack></back></article>`,
    );
    expect(sections.text).toEqual(["Grant A1."]);
    expect(JSON.stringify(sections)).not.toContain("Authorname");
  });

  it("keeps the words either side of a dropped sec-meta apart (#229)", () => {
    expect(
      fundingSections(
        `<article><back><ack>Grant C1234<sec-meta/>A5678.</ack></back></article>`,
      ).text,
    ).toEqual(["Grant C1234 A5678."]);
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

// Europe PMC often prints the funding statement in a back-matter note or a
// footnote with no funding type (#505). The cutter keeps one that is about
// funding: by its type, by its title, or, when it has neither, by naming
// the funder. It keeps no other note or footnote.
describe("keeping funding notes and footnotes (#505)", () => {
  const back = (xml: string) =>
    fundingSections(`<article><back>${xml}</back></article>`);

  it("passes a CRUK grant in a back-matter note to the rules", () => {
    const sections = back(
      '<notes notes-type="funding-information"><title>Funding</title>' +
        "<p>This work was funded by Cancer Research UK (C1234/A56789).</p></notes>",
    );
    expect(sections.text).toEqual([
      "This work was funded by Cancer Research UK (C1234/A56789).",
    ]);
    expect(
      findReferences(sections).map(({ normalised }) => normalised),
    ).toEqual(["C1234/A56789"]);
  });

  it("passes a CRUK grant in an untyped, untitled footnote to the rules", () => {
    const sections = back(
      "<fn-group><fn><p>Supported by a CRUK award (C1234/A56789).</p></fn></fn-group>",
    );
    expect(sections.text).toEqual([
      "Supported by a CRUK award (C1234/A56789).",
    ]);
    expect(
      findReferences(sections).map(({ normalised }) => normalised),
    ).toEqual(["C1234/A56789"]);
  });

  it.each([
    [
      '<notes notes-type="funding"><title>Funding information</title><p>a</p></notes>',
    ],
    ['<notes notes-type="funding-information"><p>a</p></notes>'],
    ['<notes notes-type="financial-disclosure"><p>a</p></notes>'],
    ["<notes><title>Funding</title><p>a</p></notes>"],
    [
      "<notes><label>1</label><title>Sources of funding</title><p>a</p></notes>",
    ],
    ['<fn-group><fn fn-type="funding-information"><p>a</p></fn></fn-group>'],
    ["<fn-group><fn><title>Funding</title><p>a</p></fn></fn-group>"],
  ])("keeps the note marked as funding by its type or title in %s", (xml) => {
    expect(back(xml).text).toEqual(["a"]);
  });

  it("keeps a funding note nested in a note that is not about funding", () => {
    expect(
      back(
        "<notes><title>Declarations</title>" +
          "<notes><title>Consent for publication</title><p>b</p></notes>" +
          '<notes notes-type="funding"><title>Funding</title><p>a</p></notes>' +
          "</notes>",
      ).text,
    ).toEqual(["a"]);
  });

  it.each([
    [
      "author contributions",
      '<notes notes-type="author-contribution"><title>Author contributions</title><p>Authorname wrote it.</p></notes>',
    ],
    [
      "competing interests that name the funder",
      '<notes notes-type="COI-statement"><title>Competing interests</title><p>Authorname holds a Cancer Research UK grant.</p></notes>',
    ],
    [
      "a titled note that names the funder",
      "<notes><title>Data availability</title><p>Data from the CRUK biobank.</p></notes>",
    ],
    [
      "a typed footnote that names the funder",
      '<fn-group><fn fn-type="conflict"><p>Authorname holds a CRUK grant.</p></fn></fn-group>',
    ],
    [
      "an untitled note that does not name the funder",
      "<notes><p>Data are available on request.</p></notes>",
    ],
    [
      "an untyped footnote that does not name the funder",
      "<fn-group><fn><p>Authorname and Authorname contributed equally.</p></fn></fn-group>",
    ],
    [
      "an untitled note whose only mention of the funder is in a section it holds",
      "<notes><p>Other notes.</p><sec><title>Methods</title><p>CRUK biobank.</p></sec></notes>",
    ],
  ])("leaves out %s", (_what, xml) => {
    const sections = back(xml);
    expect(sections.text).toEqual([]);
    expect(JSON.stringify(sections)).not.toContain("Authorname");
  });
  // An author note holds a correspondence address, a present address or a
  // note of equal contribution, so naming the funder there is an address.
  // A typed funding footnote there is still kept, as before.
  it("leaves out an author note that names the funder, but keeps a typed funding one", () => {
    const sections = fundingSections(
      "<article><front><article-meta><author-notes>" +
        "<fn><p>Present address: Authorname, CRUK Institute.</p></fn>" +
        '<fn fn-type="financial-disclosure"><p>a</p></fn>' +
        "</author-notes></article-meta></front></article>",
    );
    expect(sections.text).toEqual(["a"]);
  });

  // A self-closing title names nothing, as in a section (#221), so the note
  // is read as one with no title.
  it("reads a note whose title is self-closing as untitled", () => {
    expect(
      back("<notes><title/><p>Funded by Cancer Research UK.</p></notes>").text,
    ).toEqual(["Funded by Cancer Research UK."]);
  });

  // A footnote inside a funding note is read, or left out, on its own, as a
  // nested note is.
  it("leaves out a footnote that is not about funding inside a funding note", () => {
    const sections = back(
      '<notes notes-type="funding"><p>a</p>' +
        '<fn-group><fn fn-type="conflict"><p>Authorname consults.</p></fn></fn-group>' +
        "</notes>",
    );
    expect(sections.text).toEqual(["a"]);
    expect(JSON.stringify(sections)).not.toContain("Authorname");
  });

  it("reads the sections of a funding note", () => {
    expect(
      back(
        '<notes notes-type="funding-information"><sec><p>a</p></sec></notes>',
      ).text,
    ).toEqual(["a"]);
  });

  // A note marked as funding by its type or title keeps its untitled
  // sections and its funding sections. A section titled as something else,
  // such as author contributions, is about that, at any depth in the note
  // (#541).
  it.each([
    [
      "a typed note",
      '<notes notes-type="funding-information"><p>a</p>' +
        "<sec><title>Author contributions</title><p>Authorname wrote it.</p></sec></notes>",
    ],
    [
      "a titled note",
      "<notes><title>Funding</title><p>a</p>" +
        "<sec><title>Author contributions</title><p>Authorname wrote it.</p></sec></notes>",
    ],
    [
      "a typed note, wrapped in another element",
      '<notes notes-type="funding"><p>a</p><boxed-text>' +
        "<sec><title>Author contributions</title><p>Authorname wrote it.</p></sec>" +
        "</boxed-text></notes>",
    ],
    [
      "a typed note, inside an untitled section",
      '<notes notes-type="funding"><sec><p>a</p>' +
        "<sec><label>1</label><title>Author contributions</title><p>Authorname wrote it.</p></sec>" +
        "</sec></notes>",
    ],
    [
      "a typed footnote",
      '<fn-group><fn fn-type="funding"><p>a</p>' +
        "<sec><title>Author contributions</title><p>Authorname wrote it.</p></sec></fn></fn-group>",
    ],
  ])("leaves out a section that is not about funding in %s", (_what, xml) => {
    const sections = back(xml);
    expect(sections.text).toEqual(["a"]);
    expect(JSON.stringify(sections)).not.toContain("Authorname");
  });

  it("keeps the funding sections of a typed note", () => {
    expect(
      back(
        '<notes notes-type="funding"><p>a</p>' +
          "<sec><title>Grant support</title><p>b</p></sec>" +
          '<sec sec-type="funding"><title>Our grants</title><p>c</p></sec>' +
          "</notes>",
      ).text,
    ).toEqual(["b", "c", "a"]);
  });

  // A funding section keeps only its untitled subsections and its funding
  // subsections, wherever it stands: in a note or in the body (#563).
  it.each([
    [
      "in a funding note",
      '<back><notes notes-type="funding"><sec><title>Funding</title><p>a</p>' +
        "<sec><title>Author contributions</title><p>Authorname wrote it.</p></sec>" +
        "</sec></notes></back>",
    ],
    [
      "in the body",
      "<body><sec><title>Funding</title><p>a</p>" +
        "<sec><label>1</label><title>Author contributions</title><p>Authorname wrote it.</p></sec>" +
        "</sec></body>",
    ],
    [
      "typed, in the body, with the subsection wrapped",
      '<body><sec sec-type="funding"><p>a</p><boxed-text>' +
        "<sec><title>Author contributions</title><p>Authorname wrote it.</p></sec>" +
        "</boxed-text></sec></body>",
    ],
    [
      "in the body, with an untitled subsection typed as something else",
      "<body><sec><title>Funding</title><p>a</p>" +
        '<sec sec-type="author-contributions"><p>Authorname wrote it.</p></sec>' +
        "</sec></body>",
    ],
  ])(
    "leaves out a subsection that is not about funding of a funding section %s",
    (_what, xml) => {
      const sections = fundingSections(`<article>${xml}</article>`);
      expect(sections.text).toEqual(["a"]);
      expect(JSON.stringify(sections)).not.toContain("Authorname");
    },
  );

  it("keeps the untitled and funding subsections of a funding section", () => {
    expect(
      fundingSections(
        "<article><body><sec><title>Funding</title><p>a</p>" +
          "<sec><p>b</p></sec>" +
          "<sec><title>Grant support</title><p>c</p></sec>" +
          '<sec sec-type="funding"><p>d</p></sec>' +
          "</sec></body></article>",
      ).text,
    ).toEqual(["a", "b", "c", "d"]);
  });

  // An empty or blank title names nothing, as a self-closing one does
  // (#221), so the subsection is read as untitled and kept (#600).
  it.each([
    ["empty", "<title></title>"],
    ["blank", "<title> </title>"],
  ])(
    "keeps a subsection of a funding section whose title is %s (#600)",
    (_what, title) => {
      expect(
        fundingSections(
          "<article><body><sec><title>Funding</title><p>a</p>" +
            `<sec>${title}<p>b</p></sec>` +
            "</sec></body></article>",
        ).text,
      ).toEqual(["a", "b"]);
    },
  );

  it.each([
    ["empty", "<title></title>"],
    ["blank", "<title> </title>"],
  ])(
    "keeps a subsection of a funding note whose title is %s (#600)",
    (_what, title) => {
      expect(
        back(
          `<notes notes-type="funding"><p>a</p><sec>${title}<p>b</p></sec></notes>`,
        ).text,
      ).toEqual(["a", "b"]);
    },
  );

  it.each([
    ["empty", "<title></title>"],
    ["blank", "<title> </title>"],
  ])("reads a note whose title is %s as untitled (#600)", (_what, title) => {
    expect(
      back(`<notes>${title}<p>Funded by Cancer Research UK.</p></notes>`).text,
    ).toEqual(["Funded by Cancer Research UK."]);
  });

  // A section's type counts as its title, so a section typed as something
  // other than funding is left out of a funding note, and one typed as
  // funding is kept (#563).
  it("leaves out an untitled section typed as something else in a funding note", () => {
    const sections = back(
      '<notes notes-type="funding"><p>a</p>' +
        '<sec sec-type="author-contributions"><p>Authorname wrote it.</p></sec>' +
        '<sec sec-type="funding"><p>b</p></sec>' +
        '<sec sec-type=" "><p>c</p></sec></notes>',
    );
    expect(sections.text).toEqual(["b", "a", "c"]);
    expect(JSON.stringify(sections)).not.toContain("Authorname");
  });

  // A note or footnote at any depth in a funding note is read, or left out,
  // on its own, not as part of the note it stands in (#563).
  it.each([
    [
      "a wrapped note",
      '<notes notes-type="funding"><p>a</p><boxed-text>' +
        "<notes><title>Author contributions</title><p>Authorname</p></notes>" +
        "</boxed-text></notes>",
    ],
    [
      "a note in a section",
      '<notes notes-type="funding"><p>a</p><sec>' +
        '<notes notes-type="conflict"><p>Authorname consults.</p></notes>' +
        "</sec></notes>",
    ],
    [
      "a wrapped footnote",
      '<notes notes-type="funding"><p>a</p><boxed-text>' +
        '<fn-group><fn fn-type="conflict"><p>Authorname consults.</p></fn></fn-group>' +
        "</boxed-text></notes>",
    ],
  ])(
    "leaves out %s that is not about funding inside a funding note",
    (_what, xml) => {
      const sections = back(xml);
      expect(sections.text).toEqual(["a"]);
      expect(JSON.stringify(sections)).not.toContain("Authorname");
    },
  );

  it("reads a wrapped funding note inside a funding note on its own", () => {
    expect(
      back(
        '<notes notes-type="funding"><p>a</p><boxed-text>' +
          '<notes notes-type="funding"><p>b</p></notes>' +
          "</boxed-text></notes>",
      ).text,
    ).toEqual(["a", "b"]);
  });

  // A note kept for its own words drops its sections at any depth, so
  // wrapping one in another element does not let it in (#541).
  it("leaves out a wrapped section of a note kept for its own words", () => {
    const sections = back(
      "<notes><p>Supported by CRUK.</p><boxed-text>" +
        "<sec><title>Author contributions</title><p>Authorname wrote it.</p></sec>" +
        "</boxed-text></notes>",
    );
    expect(sections.text).toEqual(["Supported by CRUK."]);
    expect(JSON.stringify(sections)).not.toContain("Authorname");
  });

  // An untitled section wrapped in another element does not say it is about
  // something else, so it stays part of the note's own words (#541).
  it("reads a wrapped, untitled section as a note's own words", () => {
    expect(
      back(
        "<notes><boxed-text><sec><p>Supported by Cancer Research UK.</p></sec></boxed-text></notes>",
      ).text,
    ).toEqual(["Supported by Cancer Research UK."]);
  });

  // A note kept for naming the funder in its own words is about funding
  // only in those words, so of the sections it holds the cut keeps only the
  // funding sections, which it finds as it finds every funding section, ahead
  // of the notes (#526). Author contributions name people.
  it("keeps only the funding sections of a note kept for its own words", () => {
    const sections = back(
      "<notes><p>Supported by Cancer Research UK.</p>" +
        "<sec><title>Author contributions</title><p>Authorname wrote it.</p></sec>" +
        "<sec><title>Data availability</title><p>B data.</p></sec>" +
        "<sec><title>Funding</title><p>Grant A1.</p></sec>" +
        "</notes>",
    );
    expect(sections.text).toEqual([
      "Grant A1.",
      "Supported by Cancer Research UK.",
    ]);
    expect(JSON.stringify(sections)).not.toContain("Authorname");
  });

  it("keeps only the funding sections of a footnote kept for its own words", () => {
    const sections = back(
      "<fn-group><fn><p>Supported by CRUK.</p>" +
        "<sec><title>Author contributions</title><p>Authorname wrote it.</p></sec>" +
        "</fn></fn-group>",
    );
    expect(sections.text).toEqual(["Supported by CRUK."]);
    expect(JSON.stringify(sections)).not.toContain("Authorname");
  });

  it("reads a note with an empty type by the funder's name", () => {
    expect(
      back('<notes notes-type=""><p>Funded by Cancer Research UK.</p></notes>')
        .text,
    ).toEqual(["Funded by Cancer Research UK."]);
  });

  // A footnote is read by the funder's name only in a footnote group, where
  // papers print funding notes. A table footnote, an author's footnote or a
  // contributor's names the funder as a place or a trial, not as funding.
  it.each([
    [
      "a table footnote",
      "<body><sec><table-wrap><table-wrap-foot><fn><p>Authorname's CRUK trial.</p></fn></table-wrap-foot></table-wrap></sec></body>",
    ],
    [
      "a contributor's footnote",
      "<front><article-meta><contrib-group><fn><p>Authorname, CRUK Institute.</p></fn></contrib-group></article-meta></front>",
    ],
  ])("leaves out %s that names the funder", (_what, xml) => {
    const sections = fundingSections(`<article>${xml}</article>`);
    expect(sections.text).toEqual([]);
  });

  it("reads a footnote group's footnote by the funder's name in the body too", () => {
    expect(
      fundingSections(
        "<article><body><sec><fn-group><fn><p>Funded by CRUK.</p></fn></fn-group></sec></body></article>",
      ).text,
    ).toEqual(["Funded by CRUK."]);
  });
});

// The cutter reads an <ack> and a funding footnote by name, so these read
// each through what the cutter keeps.
describe("reading an element by its name", () => {
  const acks = (xml: string) =>
    fundingSections(`<article><back>${xml}</back></article>`).text;

  it("matches only the whole name, not a longer name it begins", () => {
    expect(
      acks(
        '<fn-group fn-type="funding"><p>one</p></fn-group><ack-x>two</ack-x><ack>three</ack>',
      ),
    ).toEqual(["three"]);
  });

  it("matches an element with no attributes or with whitespace after its name", () => {
    expect(acks("<ack>a</ack><ack\n>b</ack>")).toEqual(["a", "b"]);
  });

  it("reads a self-closing element by its whole name too", () => {
    expect(acks("<ack-x/>a<ack/>b<ack>x</ack>")).toEqual(["x"]);
  });

  // XML allows white space before a closing tag's > (#217).
  it("ends an element at a closing tag with white space before its >", () => {
    expect(acks("<ack>a</ack ><ack>b</ack\n>")).toEqual(["a", "b"]);
  });

  it("ends an unbalanced element at the next tag of its name, with white space before its > (#263)", () => {
    expect(acks("<ack>a<ack>b</ack >c<ack>d</ack >")).toEqual(["a", "b", "d"]);
  });

  it("reads a well-formed element whole when one after it is never closed", () => {
    expect(acks("<ack>a<ack>b</ack>c</ack><ack>d")).toEqual(["a b c"]);
  });

  it("reads elements inside elements of the same name only when the tags balance", () => {
    expect(acks("<ack>a<ack>b</ack>c</ack><ack>d</ack>")).toEqual([
      "a b c",
      "d",
    ]);
  });
});

describe("naming a sec-meta (#472)", () => {
  it.each(["sec-meta", "SEC-META", "Sec-Meta"])("names %s", (name) => {
    expect(isSecMetaName(name)).toBe(true);
  });

  it.each(["sec", "meta", "sec-metadata", "x-sec-meta", ""])(
    "does not name %j",
    (name) => {
      expect(isSecMetaName(name)).toBe(false);
    },
  );
});

describe("reading an element by an attribute (#217)", () => {
  const footnotes = (xml: string) =>
    fundingSections(
      `<article><back><fn-group>${xml}</fn-group></back></article>`,
    ).text;

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

// The cases the regular expressions misread, which the XML parser reads by
// design (#343).
describe("reading JATS through an XML parser (#343)", () => {
  const body = (section: string) =>
    `<article><body><sec><title>Results</title><p>Body text.</p></sec>${section}</body></article>`;

  it.each([
    [
      "<sec><title><italic>Acknowledgements</italic></title><p>Grant A1.</p></sec>",
    ],
    ["<sec><title><bold>Funding</bold></title><p>Grant A1.</p></sec>"],
  ])(
    "finds a funding title wrapped in inline markup, in %s (#240)",
    (section) => {
      expect(fundingSections(body(section)).text).toEqual(["Grant A1."]);
    },
  );

  it("keeps no text from a sec-meta whose closing tag has white space before its > (#286, #290, #292)", () => {
    const sections = fundingSections(
      body(
        "<sec><sec-meta><contrib-group><contrib><name><surname>Authorname</surname></name></contrib></contrib-group></sec-meta ><title>Funding</title><p>Grant A1.</p></sec>",
      ),
    );
    expect(sections.text).toEqual(["Grant A1."]);
    expect(JSON.stringify(sections)).not.toContain("Authorname");
  });

  it("finds a funding section whose sec-meta closes with white space before its > (#292)", () => {
    expect(
      fundingSections(
        body(
          "<sec><sec-meta><kwd-group><kwd>k</kwd></kwd-group></sec-meta ><title>Funding</title><p>Grant A1.</p></sec>",
        ),
      ).text,
    ).toEqual(["Grant A1."]);
  });

  it("finds a funding section whose label closes with white space before its > (#286, #290)", () => {
    const xml =
      "<sec><label>1</label ><title>Funding</title><p>Grant A1.</p></sec>";
    expect(fundingSections(body(xml)).text).toEqual(["Grant A1."]);
  });

  it("keeps no title words when the title closes with white space before its > (#286)", () => {
    expect(
      fundingSections(
        body(
          '<sec sec-type="funding"><title>Funding statement</title >Grant A1.</sec>',
        ),
      ).text,
    ).toEqual(["Grant A1."]);
    expect(
      fundingSections(body("<sec><title>Funding</title >Grant A1.</sec>")).text,
    ).toEqual(["Grant A1."]);
  });

  it("reads sec-type only as a whole attribute, in either kind of quotes (#287)", () => {
    expect(
      fundingSections(body(`<sec sec-type='funding'><p>Grant A1.</p></sec>`))
        .text,
    ).toEqual(["Grant A1."]);
    expect(
      fundingSections(
        body(
          `<sec data-sec-type="funding"><p>Made-up text.</p></sec>` +
            `<sec title='sec-type="funding"'><p>Made-up text.</p></sec>`,
        ),
      ).text,
    ).toEqual([]);
  });

  it("reads an id or a rid only as a whole attribute (#287)", () => {
    expect(
      fundingSections(
        `<article><front><article-meta><funding-group><award-group>` +
          `<funding-source id="fs1">Cancer Research UK</funding-source>` +
          `<funding-source title=" id='fs1'" id="fs2">Example Trust</funding-source>` +
          `<award-id title=" rid='fs2'" rid="fs1">67890</award-id>` +
          `</award-group></funding-group></article-meta></front></article>`,
      ).awards,
    ).toEqual([{ sources: ["Cancer Research UK"], ids: ["67890"] }]);
  });

  it("reads an opening tag whole when a quoted value holds a > (#288)", () => {
    expect(
      fundingSections(
        `<article><back><fn-group><fn title="a>b" fn-type="funding"><p>Grant A1.</p></fn></fn-group></back></article>`,
      ).text,
    ).toEqual(["Grant A1."]);
    expect(
      fundingSections(
        body(`<sec title="a>b" sec-type="funding"><p>Grant A1.</p></sec>`),
      ).text,
    ).toEqual(["Grant A1."]);
  });

  it.each([
    ["label", "<label>1"],
    ["sec-meta", "<sec-meta><kwd>k</kwd>"],
  ])(
    "does not run an unclosed %s on to a later section's title (#289)",
    (_name, open) => {
      const xml = `<sec>${open}<title>Methods</title><p>Body text.</p></sec><sec><label>2</label><title>Funding</title><p>Grant A1.</p></sec>`;
      const sections = fundingSections(body(xml));
      expect(sections.text).toEqual(["Grant A1."]);
      expect(JSON.stringify(sections)).not.toContain("Body text");
    },
  );

  it.each([
    ["a processing instruction", "<?pi?>"],
    ["a closing tag with white space before its >", "<label>1</label >"],
  ])("finds a funding section by its < after %s (#386)", (_after, before) => {
    const xml = `<body>${before}<sec sec-type="funding"><p>A1.</p></sec></body>`;
    expect(fundingSections(`<article>${xml}</article>`).text).toEqual(["A1."]);
  });

  it("strips a title in any case (#292)", () => {
    expect(
      fundingSections(
        "<article><back><ack><sec><TITLE>Thanks</TITLE>Grant A1.</sec></ack></back></article>",
      ).text,
    ).toEqual(["Grant A1."]);
  });

  // Only an element the cutter reads by its name is read with care when its
  // tags do not balance (#263). Any other element never closed ends at its
  // parent's closing tag, and keeps its words.
  it("keeps the words of an inline element never closed in a funding paragraph", () => {
    expect(
      fundingSections(
        "<article><back><ack><p>Funded by <italic>Example Trust grant A1.</p></ack></back></article>",
      ).text,
    ).toEqual(["Funded by Example Trust grant A1."]);
  });

  it.each([
    ["back", "<article><back><ack><p>Grant A1.</p></ack></article>"],
    ["article", "<article><back><ack><p>Grant A1.</p></ack></back>"],
  ])("keeps the funding parts when the %s is never closed", (_name, xml) => {
    expect(fundingSections(xml).text).toEqual(["Grant A1."]);
  });

  it("resolves no entity and reads no DTD", () => {
    const dtd = new URL("../../package.json", import.meta.url).href;
    const sections = fundingSections(
      `<?xml version="1.0"?>\n<!DOCTYPE article SYSTEM "${dtd}" [\n` +
        `<!ENTITY inside "Expanded text">\n<!ENTITY outside SYSTEM "${dtd}">\n]>\n` +
        `<article><back><ack><p>Grant A1 &inside; &outside;.</p></ack></back></article>`,
    );
    expect(sections.text).toEqual(["Grant A1 &inside; &outside;."]);
    const kept = JSON.stringify(sections);
    expect(kept).not.toContain("Expanded");
    expect(kept).not.toContain("grantlink");
  });
});

// Markup that is not well-formed XML, which the regular expressions read one
// way and the XML parser another (#354). Europe PMC's XML is well-formed, so
// none has been seen there.
describe("reading markup that is not well-formed XML (#354)", () => {
  it.each([
    ["<SEC><title>Funding</title><p>Grant A1.</p></sec>"],
    ["<sec><title>Funding</title><p>Grant A1.</p></SEC>"],
    ["<Sec><Title>Funding</Title><P>Grant A1.</P></sEC>"],
  ])(
    "closes a section whose tags differ only in case, in %s, as before #343",
    (section) => {
      expect(
        fundingSections(`<article><body>${section}</body></article>`).text,
      ).toEqual(["Grant A1."]);
    },
  );

  it.each([
    ['<fn fn-type="other" fn-type="funding">'],
    ['<fn fn-type="funding" fn-type="other">'],
  ])(
    "reads a footnote as funding when any of its repeated types is funding, in %s, as before #343",
    (tag) => {
      expect(
        fundingSections(
          `<article><back><fn-group>${tag}<p>Grant A1.</p></fn></fn-group></back></article>`,
        ).text,
      ).toEqual(["Grant A1."]);
    },
  );

  it.each([
    ['<sec sec-type="other" sec-type="funding">'],
    ['<sec sec-type="funding" sec-type="other">'],
  ])(
    "reads a section as funding when any of its repeated types is funding, in %s, as before #343",
    (tag) => {
      expect(
        fundingSections(
          `<article><body>${tag}<p>Grant A1.</p></sec></body></article>`,
        ).text,
      ).toEqual(["Grant A1."]);
    },
  );
});
