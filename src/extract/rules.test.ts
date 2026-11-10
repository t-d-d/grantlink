import { describe, expect, it } from "vitest";
import { findReferences, referenceSchema, RULES_VERSION } from "./rules.ts";

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
    // The forms gold set B holds that rules-2 missed (#177).
    ["FC001234", "FC001234", "FCn"],
    ["CC2001", "CC2001", "CCn"],
    ["RT1234", "RT1234", "RTn"],
    ["G123/45", "G123/45", "Gn/n"],
    ["ABCDEF- Nov21/100001", "ABCDEF-NOV21/100001", "CODE-MonYY/n"],
    ["ABCDEF\u2010Nov21/100001", "ABCDEF-NOV21/100001", "CODE-MonYY/n"],
    // The minus sign in place of a hyphen (#269).
    ["ABCDEF\u2212Nov21/100001", "ABCDEF-NOV21/100001", "CODE-MonYY/n"],
    ["ABCDEFApr2020\\100001", "ABCDEFAPR2020/100001", "CODEMonYYYY/n"],
    ["ABCDEFNov21/100001", "ABCDEFNOV21/100001", "CODEMonYY/n"],
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

  it("reads the A numbers after CR-UK", () => {
    expect(
      findReferences(sections("Supported by CR-UK (A12345 and A23456).")),
    ).toEqual([
      { asWritten: "A12345", normalised: "A12345", format: "An" },
      { asWritten: "A23456", normalised: "A23456", format: "An" },
    ]);
  });

  // A Unicode hyphen or dash (U+2010 to U+2015) in the funder's name (#201).
  it.each(["\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015"])(
    "reads an A number after CR%sUK",
    (dash) => {
      expect(
        findReferences(sections(`Funded by CR${dash}UK (A12345).`)),
      ).toEqual([{ asWritten: "A12345", normalised: "A12345", format: "An" }]);
    },
  );

  // The minus sign in place of the hyphen in the funder's name (#269).
  it("reads an A number after CR-UK written with a minus sign", () => {
    expect(findReferences(sections("Funded by CR\u2212UK (A12345)."))).toEqual([
      { asWritten: "A12345", normalised: "A12345", format: "An" },
    ]);
  });

  // A no-break space between two words of the funder's name (#269).
  it.each([
    "Cancer\u00a0Research UK",
    "Cancer Research\u00a0UK",
    "Cancer\u00a0Research\u00a0U.K.",
  ])("reads an A number after %j", (name) => {
    expect(findReferences(sections(`Funded by ${name} (A12345).`))).toEqual([
      { asWritten: "A12345", normalised: "A12345", format: "An" },
    ]);
  });

  it("reads a G number in brackets after a funder name with a no-break space", () => {
    expect(
      findReferences(sections("Funded by cancer research\u00a0uk (G123/45).")),
    ).toEqual([
      { asWritten: "G123/45", normalised: "G123/45", format: "Gn/n" },
    ]);
  });

  it("reads a G number in brackets after CR-UK written with a Unicode hyphen", () => {
    expect(findReferences(sections("Funded by cr\u2010uk (G123/45)."))).toEqual(
      [{ asWritten: "G123/45", normalised: "G123/45", format: "Gn/n" }],
    );
  });

  it.each([
    ["a Crick core funding number", "FC001234"],
    ["a newer Crick core funding number", "CC2001"],
    ["a joint award number", "Award RT1234"],
  ])("leaves %s in a sentence that names another funder", (_, written) => {
    expect(
      findReferences(
        sections(
          `We thank Cancer Research UK for support. The Example Trust funded ${written}.`,
        ),
      ),
    ).toEqual([]);
  });

  it("leaves a reference credited to Cancer Research, UK, another charity", () => {
    expect(
      findReferences(
        sections(
          "Funded by the Example Foundation for Cancer Research, UK (A12345).",
        ),
      ),
    ).toEqual([]);
  });

  it("leaves a lowercase g number", () => {
    expect(findReferences(sections("Cancer Research UK (g123/45)."))).toEqual(
      [],
    );
  });

  it("reads a G number after the funder's name in any case", () => {
    expect(
      findReferences(sections("Funded by cancer research uk (G123/45).")),
    ).toEqual([
      { asWritten: "G123/45", normalised: "G123/45", format: "Gn/n" },
    ]);
  });

  it("leaves a G number in another funder's brackets", () => {
    expect(
      findReferences(
        sections("Cancer Research UK and the Example Council (G123/45)."),
      ),
    ).toEqual([]);
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

  it("lists a bare number once when the text also gives it with its FC", () => {
    expect(
      findReferences({
        text: ["Cancer Research UK (FC 001234)."],
        awards: [{ sources: ["Cancer Research UK"], ids: ["001234"] }],
      }),
    ).toEqual([
      { asWritten: "FC 001234", normalised: "FC001234", format: "FCn" },
    ]);
  });

  // The dedupe once saw only the references found so far, so it hung on
  // the order of the award groups (#241).
  it.each([
    ["the bare number comes first", ["12345"], ["A12345"]],
    ["the lettered number comes first", ["A12345"], ["12345"]],
  ])(
    "lists a bare number once when another award group gives it with its A, when %s",
    (_order, first, second) => {
      expect(
        findReferences({
          text: ["Funded by grant 12345."],
          awards: [
            { sources: ["Cancer Research UK"], ids: first },
            { sources: ["Cancer Research UK"], ids: second },
          ],
        }),
      ).toEqual([{ asWritten: "A12345", normalised: "A12345", format: "An" }]);
    },
  );

  it.each([
    ["the bare number comes first", ["12345", "A12345"]],
    ["the lettered number comes first", ["A12345", "12345"]],
  ])(
    "lists a bare number once when the same award group gives it with its A, when %s",
    (_order, ids) => {
      expect(
        findReferences({
          text: ["Funded by grant 12345."],
          awards: [{ sources: ["Cancer Research UK"], ids }],
        }),
      ).toEqual([{ asWritten: "A12345", normalised: "A12345", format: "An" }]);
    },
  );

  it("returns only references the table accepts, whatever space follows a hyphen", () => {
    const found = findReferences(
      sections("Cancer Research UK (ABCDEF-\u00a0Nov21/100001)."),
    );
    for (const reference of found) {
      expect(referenceSchema.safeParse(reference).success).toBe(true);
    }
  });

  it("returns only references the table accepts when a minus sign stands for a hyphen", () => {
    const found = findReferences(
      sections("Cancer Research UK (ABCDEF\u2212Nov21/100001)."),
    );
    expect(found).toHaveLength(1);
    for (const reference of found) {
      expect(referenceSchema.safeParse(reference).success).toBe(true);
    }
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
