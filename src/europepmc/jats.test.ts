import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findReferences } from "../extract/rules.ts";
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

    it.each([
      ["<sec><title>Support vector machines</title><p>Method.</p></sec>"],
      ["<sec><title>Support needs of carers</title><p>Method.</p></sec>"],
    ])("nor a body section whose title goes on past Support, %s", (section) => {
      expect(fundingSections(paper(section)).text).toEqual([]);
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
