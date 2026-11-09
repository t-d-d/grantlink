import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fundingSections } from "./jats.ts";

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
      { source: "Cancer Research UK", ids: ["C1234/A56789"] },
    ]);
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
  });

  it("leaves a character reference past Unicode's range as written", () => {
    expect(
      fundingSections(
        "<article><back><ack><p>Grant &#x110000; and &#99999999;.</p></ack></back></article>",
      ).text,
    ).toEqual(["Grant &#x110000; and &#99999999;."]);
  });

  it("finds nothing in a paper with no funding sections", () => {
    expect(fundingSections("<article><body><p>x</p></body></article>")).toEqual(
      { text: [], awards: [] },
    );
  });
});
