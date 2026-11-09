import { describe, expect, it } from "vitest";
import { findReferences, RULES_VERSION } from "./rules.ts";

// Every reference here is made up in the shape of one the PRD (#1) quotes.
const sections = (...text: string[]) => ({ text, awards: [] });

describe("the rules", () => {
  it("has a version, recorded with every result", () => {
    expect(RULES_VERSION).toMatch(/^rules-\d+$/u);
  });

  it.each([
    ["C1234/A56789", "C1234/A56789", "Cn/An"],
    ["C 1234 / A 56789", "C1234/A56789", "Cn/An"],
    ["CTRQQR-2021\\100010", "CTRQQR-2021/100010", "CODE-YYYY/n"],
    ["RRCOER-Jun24/100008", "RRCOER-JUN24/100008", "CODE-MonYY/n"],
    ["DRCMDPA∖100010", "DRCMDPA/100010", "CODE/n"],
  ])("reads %s as %s", (written, normalised, format) => {
    const found = findReferences(
      sections(`This work was funded by Cancer Research UK (${written}).`),
    );
    expect(found).toEqual([{ asWritten: written, normalised, format }]);
  });

  it("reads an A number in a sentence that names the funder", () => {
    expect(
      findReferences(sections("Supported by CRUK grant A28707 to the lab.")),
    ).toEqual([{ asWritten: "A28707", normalised: "A28707", format: "An" }]);
  });

  it("does not end a sentence at the dots in U.K.", () => {
    expect(
      findReferences(sections("Supported by Cancer Research U.K. (A12345).")),
    ).toEqual([{ asWritten: "A12345", normalised: "A12345", format: "An" }]);
  });

  it("leaves an A number in a sentence that names another funder", () => {
    expect(
      findReferences(
        sections(
          "We thank Cancer Research UK for support. The Example Trust funded grant A12345.",
        ),
      ),
    ).toEqual([]);
  });

  it("does not read the A part of a C/A reference twice", () => {
    expect(
      findReferences(sections("Cancer Research UK grant C1234/A56789.")),
    ).toHaveLength(1);
  });

  it("ignores a paragraph that does not name the funder", () => {
    expect(
      findReferences(
        sections("Funded by the Example Council (EXMPLE/100001)."),
      ),
    ).toEqual([]);
  });

  it("reads an award the metadata gives the funder, without the name in the id", () => {
    expect(
      findReferences({
        text: [],
        awards: [{ sources: ["Cancer Research UK"], ids: ["A29999", "x"] }],
      }),
    ).toEqual([{ asWritten: "A29999", normalised: "A29999", format: "An" }]);
  });

  it("ignores an award from another funder", () => {
    expect(
      findReferences({
        text: [],
        awards: [{ sources: ["Example Trust"], ids: ["A29999"] }],
      }),
    ).toEqual([]);
  });

  // A bare number counts only when the metadata gives it to the funder and
  // the paper's own text gives the same number (#97).
  it("reads a bare number the metadata gives the funder when the text gives it too", () => {
    expect(
      findReferences({
        text: ["This work was funded by a grant (Grant No. 12345)."],
        awards: [{ sources: ["Cancer Research UK"], ids: ["12345"] }],
      }),
    ).toEqual([{ asWritten: "12345", normalised: "12345", format: "n" }]);
  });

  it("leaves a bare number the metadata gives the funder when the text does not give it", () => {
    expect(
      findReferences({
        text: ["This work was funded by Cancer Research UK."],
        awards: [{ sources: ["Cancer Research UK"], ids: ["12345"] }],
      }),
    ).toEqual([]);
  });

  it("leaves a bare number the text gives only inside a longer reference", () => {
    expect(
      findReferences({
        text: ["Funded by the Example Trust (B12345 and 123456)."],
        awards: [{ sources: ["Cancer Research UK"], ids: ["12345"] }],
      }),
    ).toEqual([]);
  });

  it.each([
    ["Cancer Research UK (CTRQQR-2021/100010).", "CTRQQR-2021/100010"],
    ["Cancer Research UK (CTRQQR-2021 / 100010).", "CTRQQR-2021/100010"],
    ["Cancer Research UK (DRCMDPA∖100010).", "DRCMDPA/100010"],
  ])(
    "leaves a bare number the text gives only after a separator, in %s",
    (text, normalised) => {
      expect(
        findReferences({
          text: [text],
          awards: [{ sources: ["Cancer Research UK"], ids: ["100010"] }],
        }).map((reference) => reference.normalised),
      ).toEqual([normalised]);
    },
  );

  it("lists a bare number once when the text also gives it with its A", () => {
    expect(
      findReferences({
        text: ["Cancer Research UK (A28275). Grant 28275."],
        awards: [{ sources: ["Cancer Research UK"], ids: ["28275"] }],
      }),
    ).toEqual([{ asWritten: "A28275", normalised: "A28275", format: "An" }]);
  });

  it("leaves a bare number the metadata gives another funder", () => {
    expect(
      findReferences({
        text: ["Cancer Research UK and the Example Trust (12345)."],
        awards: [{ sources: ["Example Trust"], ids: ["12345"] }],
      }),
    ).toEqual([]);
  });

  // An award group with more than one source does not say whose its ids
  // are, unless an id names its source (#128).
  it("leaves a bare number in an award group the funder shares with another", () => {
    expect(
      findReferences({
        text: ["Funded by Cancer Research UK and the Example Trust (12345)."],
        awards: [
          { sources: ["Cancer Research UK", "Example Trust"], ids: ["12345"] },
        ],
      }),
    ).toEqual([]);
  });

  it("reads a bare number in an award group whose sources all name the funder", () => {
    expect(
      findReferences({
        text: ["Funded by Cancer Research UK (12345)."],
        awards: [{ sources: ["Cancer Research UK", "CRUK"], ids: ["12345"] }],
      }),
    ).toEqual([{ asWritten: "12345", normalised: "12345", format: "n" }]);
  });

  it("reads a reference in a known format from an award group the funder shares", () => {
    expect(
      findReferences({
        text: [],
        awards: [
          {
            sources: ["Example Trust", "Cancer Research UK"],
            ids: ["C1234/A56789"],
          },
        ],
      }),
    ).toEqual([
      {
        asWritten: "C1234/A56789",
        normalised: "C1234/A56789",
        format: "Cn/An",
      },
    ]);
  });

  it("leaves a bare number in the text that no award gives the funder", () => {
    expect(
      findReferences(sections("Funded by Cancer Research UK (grant 12345).")),
    ).toEqual([]);
  });

  it("leaves a bare number too short or too long to be a reference", () => {
    expect(
      findReferences({
        text: ["Grants 2021 and 12345678."],
        awards: [
          { sources: ["Cancer Research UK"], ids: ["2021", "12345678"] },
        ],
      }),
    ).toEqual([]);
  });

  it("lists each normalised reference once", () => {
    expect(
      findReferences(
        sections(
          "Cancer Research UK (C1234/A56789).",
          "CRUK grant C1234 / A56789.",
        ),
      ),
    ).toHaveLength(1);
  });

  it("returns nothing but references, so no name can pass through", () => {
    const found = findReferences(
      sections("Dr Ada Example thanks Cancer Research UK (C1/A12345)."),
    );
    for (const reference of found) {
      expect(reference.asWritten).toMatch(/^[A-Za-z0-9 /\\∖-]+$/u);
    }
  });
});
