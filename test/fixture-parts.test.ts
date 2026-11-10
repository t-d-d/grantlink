import { describe, expect, it } from "vitest";
import { fundingSections } from "../src/europepmc/jats.ts";
import { strayParts } from "./fixture-parts.ts";

// A full text cut as the recorded fixtures are: its ids, its licence and its
// funding metadata, and its acknowledgements.
const META =
  '<article-id pub-id-type="pmcid">PMC1</article-id>' +
  "<permissions><license><p>CC BY</p></license></permissions>" +
  "<funding-group><award-group><award-id>A1</award-id></award-group></funding-group>";
const BACK = "<ack><title>Acknowledgements</title><p>Thanks.</p></ack>";

function paper({ meta = "", front = "", body = "", back = "" } = {}): string {
  return (
    '<?xml version="1.0"?>\n<!DOCTYPE article PUBLIC "-//NLM//DTD JATS//EN" "x.dtd">\n' +
    `<article><front><article-meta>${META}${meta}</article-meta>${front}</front>` +
    `${body}<back>${BACK}${back}</back></article>`
  );
}

describe("strayParts", () => {
  it("passes a full text cut to its funding sections", () => {
    expect(strayParts(paper())).toEqual([]);
  });

  it("passes funding sections and footnotes in the back, and funding sections in the body", () => {
    expect(
      strayParts(
        paper({
          body: '<body><sec sec-type="funding"><p>Funded.</p></sec></body>',
          back:
            '<sec sec-type="funding"><title>Funding</title><p>Funded.</p></sec>' +
            '<fn-group><fn fn-type="financial-disclosure"><p>Funded.</p></fn></fn-group>' +
            '<fn fn-type="supported-by"><p>Funded.</p></fn>',
        }),
      ),
    ).toEqual([]);
  });

  it("passes body sections the cutter finds by their type or their title", () => {
    expect(
      strayParts(
        paper({
          body:
            '<body><sec sec-type="ack"><p>Thanks.</p></sec>' +
            "<sec><title>Funding</title><p>Funded.</p></sec>" +
            "<sec><label>5.</label><title>Acknowledgments</title><p>Thanks.</p></sec>" +
            "<sec><title>Support</title><p>Funded.</p></sec></body>",
          back: "<sec><title>Grant support</title><p>Funded.</p></sec>",
        }),
      ),
    ).toEqual([]);
  });

  // The check reads the raw XML, so a comment or a processing instruction
  // before a section's title must not hide the section from it either (#230).
  it("passes a funding section with a processing instruction or an empty comment before its title", () => {
    expect(
      strayParts(
        paper({
          body:
            "<body><sec><?pi x?><title>Funding</title><p>Funded.</p></sec>" +
            "<sec><label>5.</label><!----><title>Funding</title><p>Funded.</p></sec>" +
            "<sec><title><!----><?pi x?>Funding</title><p>Funded.</p></sec>" +
            "<sec><?pi a>b?><title>Funding</title><p>Funded.</p></sec></body>",
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "a body section whose title only starts with Support",
      {
        body: "<body><sec><title>Support vector machines</title><p>M</p></sec></body>",
      },
      "article/body/sec",
    ],
    [
      "a labelled body section followed by a labelled funding section",
      {
        body:
          "<body><sec><label>1.</label><title>Methods</title><p>M</p></sec>" +
          "<sec><label>2.</label><title>Funding</title><p>Funded.</p></sec></body>",
      },
      "article/body/sec",
    ],
    [
      "the sec-meta of a funding section, which can name people (#222)",
      {
        body:
          "<body><sec><sec-meta><contrib-group><contrib><name>A</name></contrib></contrib-group></sec-meta>" +
          "<title>Funding</title><p>Funded.</p></sec></body>",
      },
      "article/body/sec/sec-meta",
    ],
    [
      "a section inside the acknowledgements, which takes in any sec-meta it opens with (#229)",
      {
        back:
          "<ack><sec><sec-meta><contrib-group><contrib><bio><p>B</p></bio></contrib></contrib-group></sec-meta>" +
          "<title>Funding</title><p>G</p></sec></ack>",
      },
      "article/back/ack/sec",
    ],
    [
      "a sec-meta in the acknowledgements (#229)",
      {
        back: "<ack><sec-meta><contrib-group><contrib><bio><p>B</p></bio></contrib></contrib-group></sec-meta><p>G</p></ack>",
      },
      "article/back/ack/sec-meta",
    ],
    [
      "the author list",
      {
        meta: "<contrib-group><contrib><name>A</name></contrib></contrib-group>",
      },
      "article/front/article-meta/contrib-group",
    ],
    [
      "an affiliation",
      { meta: '<aff id="a1">Somewhere</aff>' },
      "article/front/article-meta/aff",
    ],
    [
      "the title",
      { meta: "<title-group><article-title>T</article-title></title-group>" },
      "article/front/article-meta/title-group",
    ],
    [
      "the abstract",
      { meta: "<abstract><p>A</p></abstract>" },
      "article/front/article-meta/abstract",
    ],
    [
      "the journal",
      { front: "<journal-meta><journal-id>J</journal-id></journal-meta>" },
      "article/front/journal-meta",
    ],
    [
      "the reference list",
      {
        back: "<ref-list><ref><mixed-citation>R</mixed-citation></ref></ref-list>",
      },
      "article/back/ref-list",
    ],
    [
      "a section in the back that is not about funding",
      { back: '<sec sec-type="data-availability"><p>D</p></sec>' },
      "article/back/sec",
    ],
    [
      "a footnote that is not about funding",
      { back: '<fn-group><fn fn-type="conflict"><p>C</p></fn></fn-group>' },
      "article/back/fn-group/fn",
    ],
    [
      "a body section that is not about funding",
      { body: "<body><sec><title>Methods</title><p>M</p></sec></body>" },
      "article/body/sec",
    ],
    [
      "body text outside any section",
      { body: "<body><p>Results.</p></body>" },
      "article/body/p",
    ],
    [
      "bare text in the body",
      { body: "<body>Results.</body>" },
      "article/body (text)",
    ],
    [
      "bare text in the article-meta",
      { meta: "Somebody" },
      "article/front/article-meta (text)",
    ],
    [
      "a copyright statement beside the licence",
      {
        meta: "<permissions><copyright-statement>C</copyright-statement></permissions>",
      },
      "article/front/article-meta/permissions/copyright-statement",
    ],
    [
      "a comment in the article-meta",
      { meta: "<!-- <contrib-group>A</contrib-group> -->" },
      "article/front/article-meta (text)",
    ],
  ])("names %s", (_what, parts, stray) => {
    expect(strayParts(paper(parts))).toEqual([stray]);
  });

  // #159: a section or footnote in the back passes the check when the cutter
  // reads it as funding text, and is named when it does not.
  it.each([
    '<fn fn-type="financial-disclosure"><p>Funded.</p></fn>',
    '<fn fn-type="funding"><p>Funded.</p></fn>',
    '<fn fn-type="supported-by"><p>Funded.</p></fn>',
    '<fn fn-type="conflict"><p>Funded.</p></fn>',
    '<fn-group><fn fn-type="supported-by"><p>Funded.</p></fn></fn-group>',
    '<fn-group><fn fn-type="other"><p>Funded.</p></fn></fn-group>',
    '<sec sec-type="funding"><p>Funded.</p></sec>',
    '<sec sec-type="acknowledgements"><p>Funded.</p></sec>',
    '<sec sec-type="data-availability"><p>Funded.</p></sec>',
    "<sec><title>Financial support</title><p>Funded.</p></sec>",
    "<sec><title>Support.</title><p>Funded.</p></sec>",
    "<sec><title>Supporting data</title><p>Funded.</p></sec>",
    "<sec><title>Methods</title><p>Funded.</p></sec>",
  ])("agrees with the cutter on %s in the back", (part) => {
    const xml =
      `<article><front><article-meta>${META}</article-meta></front>` +
      `<back>${part}</back></article>`;
    const read = fundingSections(xml).text.length > 0;
    expect(strayParts(xml).length === 0).toBe(read);
  });

  // #215: inside a funding part the cutter reads the paragraphs, or the
  // whole text less the title when there are none. The check names any
  // other element inside the part, and text beside its paragraphs.
  it("passes a funding part's label, title and paragraphs, and the bare text of one with no paragraphs", () => {
    expect(
      strayParts(
        paper({
          body:
            "<body><sec><label>5.</label><title>Funding</title>" +
            "<p>Funded by <italic>X</italic>.</p></sec></body>",
          back:
            '<fn fn-type="funding"><label>*</label><p>Funded.</p></fn>' +
            '<fn-group><fn fn-type="supported-by">Funded.</fn></fn-group>',
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "a contributor group inside a funding section",
      {
        back:
          '<sec sec-type="funding"><contrib-group><name>A</name></contrib-group>' +
          "<p>Funded.</p></sec>",
      },
      "article/back/sec/contrib-group",
    ],
    [
      "a contributor group inside a funding section with no paragraphs",
      {
        back: '<sec sec-type="funding"><contrib-group><name>A</name></contrib-group></sec>',
      },
      "article/back/sec/contrib-group",
    ],
    [
      "a contributor group inside a body section found by its title",
      {
        body:
          "<body><sec><title>Funding</title><p>Funded.</p>" +
          "<contrib-group><name>A</name></contrib-group></sec></body>",
      },
      "article/body/sec/contrib-group",
    ],
    [
      "a section nested in a funding section",
      {
        back:
          '<sec sec-type="funding"><p>Funded.</p>' +
          "<sec><title>Methods</title><p>M</p></sec></sec>",
      },
      "article/back/sec/sec",
    ],
    [
      "text beside the paragraphs of a funding section",
      { back: '<sec sec-type="funding">Somebody<p>Funded.</p></sec>' },
      "article/back/sec (text)",
    ],
    [
      "a name inside the acknowledgements",
      { back: "<ack><name>A</name><p>Thanks.</p></ack>" },
      "article/back/ack/name",
    ],
    [
      "a list inside a funding footnote",
      {
        back: '<fn fn-type="funding"><p>Funded.</p><list><list-item>A</list-item></list></fn>',
      },
      "article/back/fn/list",
    ],
    [
      "a comment holding text before the title of a funding section, not the section (#230)",
      {
        body: "<body><sec><!-- x --><title>Funding</title><p>Funded.</p></sec></body>",
      },
      "article/body/sec (text)",
    ],
    [
      "a comment holding text in a funding section with no paragraphs, which the cutter drops",
      {
        body: "<body><sec><!-- x --><title>Funding</title>Funded.</sec></body>",
      },
      "article/body/sec (text)",
    ],
    [
      "a comment holding text inside the title of a funding section",
      {
        body: "<body><sec><title><!-- x -->Funding</title><p>Funded.</p></sec></body>",
      },
      "article/body/sec (text)",
    ],
    [
      "a comment beside the paragraphs of a funding footnote",
      {
        back: '<fn-group><fn fn-type="funding"><!-- <name>A</name> --><p>Funded.</p></fn></fn-group>',
      },
      "article/back/fn-group/fn (text)",
    ],
    [
      "a paragraph inside the title of a funding section, which the cutter reads in place of the bare text",
      { back: '<sec sec-type="funding"><title><p>X</p></title>Somebody</sec>' },
      "article/back/sec/title/p",
    ],
    [
      "a contributor group inside the title of a funding section",
      {
        back:
          '<sec sec-type="funding"><title>Funding <contrib-group><name>A</name></contrib-group></title>' +
          "<p>Funded.</p></sec>",
      },
      "article/back/sec/title/contrib-group",
    ],
    [
      "a paragraph inside the label of a funding footnote",
      { back: '<fn fn-type="funding"><label><p>1</p></label>Somebody</fn>' },
      "article/back/fn/label/p",
    ],
    [
      "a second title in a funding section",
      {
        back: '<sec sec-type="funding"><title>Funding</title><title>Somebody</title><p>Funded.</p></sec>',
      },
      "article/back/sec/title",
    ],
    [
      "a second label in a funding footnote",
      {
        back: '<fn fn-type="funding"><label>*</label><label>Somebody</label><p>Funded.</p></fn>',
      },
      "article/back/fn/label",
    ],
  ])("names %s (#215)", (_what, parts, stray) => {
    expect(strayParts(paper(parts))).toEqual([stray]);
  });

  // #275: in a funding group the cutter reads each funding statement whole,
  // and in each award group each funding source and award id whole. The
  // check names anything else inside the group.
  const GROUP = "article/front/article-meta/funding-group";

  it("passes a funding group's statements, and its award groups' funding sources and award ids", () => {
    const meta =
      '<funding-group specific-use="FundRef">' +
      "<funding-statement>Funded by <named-content>X</named-content>.</funding-statement>" +
      '<award-group id="g1"><funding-source id="s1"><institution-wrap>' +
      '<institution-id institution-id-type="DOI">10.1/x</institution-id>' +
      "<institution>X</institution></institution-wrap></funding-source>" +
      '<award-id rid="s1">A2</award-id></award-group><award-group/>' +
      "</funding-group>";
    expect(strayParts(paper({ meta }))).toEqual([]);
  });

  it.each([
    [
      "a principal award recipient in an award group",
      "<award-group><award-id>A2</award-id><principal-award-recipient><name>A</name>" +
        "</principal-award-recipient></award-group>",
      `${GROUP}/award-group/principal-award-recipient`,
    ],
    [
      "a principal investigator in an award group",
      "<award-group><award-id>A2</award-id><principal-investigator><name>A</name>" +
        "</principal-investigator></award-group>",
      `${GROUP}/award-group/principal-investigator`,
    ],
    [
      "an award description in an award group",
      "<award-group><award-id>A2</award-id><award-desc>Somebody</award-desc></award-group>",
      `${GROUP}/award-group/award-desc`,
    ],
    [
      "an open access statement in a funding group",
      "<open-access><p>Somebody</p></open-access>",
      `${GROUP}/open-access`,
    ],
    [
      "text in a funding group beside its statements",
      "Somebody<funding-statement>Funded.</funding-statement>",
      `${GROUP} (text)`,
    ],
    [
      "text in an award group beside its award ids",
      "<award-group>Somebody<award-id>A2</award-id></award-group>",
      `${GROUP}/award-group (text)`,
    ],
    [
      "a comment holding text in a funding group",
      "<!-- <name>A</name> --><funding-statement>Funded.</funding-statement>",
      `${GROUP} (text)`,
    ],
    [
      "a comment holding text in a funding statement, which the cutter drops",
      "<funding-statement>Funded.<!-- <name>A</name> --></funding-statement>",
      `${GROUP}/funding-statement (text)`,
    ],
    [
      "a comment holding text in a funding source",
      "<award-group><funding-source>X<!-- A --></funding-source></award-group>",
      `${GROUP}/award-group/funding-source (text)`,
    ],
    [
      "a comment holding text in an award id",
      "<award-group><award-id>A2<!-- A --></award-id></award-group>",
      `${GROUP}/award-group/award-id (text)`,
    ],
  ])("names %s (#275)", (_what, inner, stray) => {
    expect(
      strayParts(paper({ meta: `<funding-group>${inner}</funding-group>` })),
    ).toEqual([stray]);
  });

  it("names a root that is not an article", () => {
    expect(strayParts("<book><p>B</p></book>")).toEqual(["book"]);
  });

  it("names text outside the root", () => {
    expect(strayParts(`${paper()}\nSomebody`)).toEqual(["(text)"]);
  });
});
