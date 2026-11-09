import { describe, expect, it } from "vitest";
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

  it.each([
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

  it("names a root that is not an article", () => {
    expect(strayParts("<book><p>B</p></book>")).toEqual(["book"]);
  });

  it("names text outside the root", () => {
    expect(strayParts(`${paper()}\nSomebody`)).toEqual(["(text)"]);
  });
});
