import { describe, expect, it, vi } from "vitest";
import funderFile from "./funder.json" with { type: "json" };
import {
  findReferences,
  namesPattern,
  referenceSchema,
  RULES_VERSION,
  sentences,
} from "./rules.ts";

// Every reference here is made up in the shape of one the PRD (#1) quotes.
const sections = (...text: string[]) => ({ text, awards: [] });

describe("the sentence split", () => {
  // Gold set B's draw reads sentences with this split too (#360).
  it("ends a sentence at a stop before a capital, but not after a single capital", () => {
    expect(
      sentences("Funded by the U.K. trust. Thanks to all; (see notes)."),
    ).toEqual(["Funded by the U.K. trust.", "Thanks to all;", "(see notes)."]);
  });
});

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

  // The forms gold set A still missed (#506), each made up in its shape.
  it.each([
    // A C/A pair with a four-digit award, and in lower case.
    ["C1234/A5678", "C1234/A5678", "Cn/An"],
    ["c123/a45678", "C123/A45678", "Cn/An"],
    ["C123/a45678", "C123/A45678", "Cn/An"],
    // A Crick number as printed, even with a digit too many (#175 rule 6).
    ["FC0012345", "FC0012345", "FCn"],
    ["FC00123456", "FC00123456", "FCn"],
    // The funder's newer and prefixed forms.
    ["CRUKDF-0123-AB", "CRUKDF-0123-AB", "CRUK-X"],
    ["ABC-CRUK-ABCD12-AB", "ABC-CRUK-ABCD12-AB", "CRUK-X"],
    ["CRUK/12/034", "CRUK/12/034", "CRUK-X"],
    ["CRUK-A12345", "CRUK-A12345", "CRUK-X"],
    // A bare number the text ties to the funder.
    ["grant 12345", "12345", "n"],
    ["grant no. 123456", "123456", "n"],
    ["award number 1234", "1234", "n"],
    ["12345", "12345", "n"],
  ])("reads %s, new in #506, as %s", (written, normalised, format) => {
    const found = findReferences(
      sections(`This work was funded by Cancer Research UK (${written}).`),
    );
    expect(found).toEqual([
      {
        asWritten: written.replace(/^(?:grant|award)\D*/u, ""),
        normalised,
        format,
      },
    ]);
  });

  it("reads an A number with four digits in a sentence that names the funder", () => {
    expect(
      findReferences(sections("CRUK core funding to the lab (A1234).")),
    ).toEqual([{ asWritten: "A1234", normalised: "A1234", format: "An" }]);
  });

  it("reads a bare number after a committee the funder names", () => {
    expect(
      findReferences(
        sections(
          "Cancer Research UK (CRUK) Example and Sample Committee (Award No. 12345).",
        ),
      ),
    ).toEqual([{ asWritten: "12345", normalised: "12345", format: "n" }]);
  });

  it("reads a Crick number after no. in the funder's brackets", () => {
    expect(
      findReferences(
        sections(
          "The Example Institute receives its core funding from CRUK (no. FC001234), and others.",
        ),
      ),
    ).toEqual([
      { asWritten: "FC001234", normalised: "FC001234", format: "FCn" },
    ]);
  });

  // A malformed pair is for the model (#177), and its first A number is no
  // grant of its own.
  it("leaves the first half of a pair of A numbers", () => {
    expect(
      findReferences(sections("Cancer Research UK grant A1234/A56789.")),
    ).toEqual([{ asWritten: "A56789", normalised: "A56789", format: "An" }]);
  });

  it("reads both halves of a pair of five-digit A numbers", () => {
    expect(
      findReferences(sections("Cancer Research UK grant A12345/A23456.")),
    ).toEqual([
      { asWritten: "A12345", normalised: "A12345", format: "An" },
      { asWritten: "A23456", normalised: "A23456", format: "An" },
    ]);
  });

  // Another funder's reference, such as a Crick African Network award,
  // may hold an A number between letters and a slash before it and a slash
  // and more after it. That A number is not the funder's (#642).
  it.each(["CAN/A00004/1", "CAN/A00003/1", "ABC\\A12345\\2", "ABC/A1234/AB"])(
    "reads no A number from inside %s",
    (written) => {
      expect(
        findReferences(
          sections(
            `Funded by Cancer Research UK (FC001234) and the Example Network (${written}).`,
          ),
        ),
      ).toEqual([
        { asWritten: "FC001234", normalised: "FC001234", format: "FCn" },
      ]);
    },
  );

  it.each([
    [
      "an A number after a slash with no letters before it",
      "C1234/A12345/2",
      "C1234/A12345",
    ],
    [
      "an A number after letters and a slash, with nothing more",
      "CRUK grant/A12345",
      "A12345",
    ],
    [
      "an A number before a slash, with no letters and slash before it",
      "A12345/2",
      "A12345",
    ],
  ])("still reads %s", (_, written, normalised) => {
    expect(
      findReferences(
        sections(`Funded by Cancer Research UK (${written}).`),
      ).map((reference) => reference.normalised),
    ).toEqual([normalised]);
  });

  it("reads each A number of a list written tight with slashes after a word", () => {
    // Another A number after the slash makes a list, not another funder's
    // reference (#642).
    expect(
      findReferences(
        sections("Funded by Cancer Research UK (grant/A12345/A23456)."),
      ).map((reference) => reference.normalised),
    ).toEqual(["A12345", "A23456"]);
  });

  it("leaves a word joined to CRUK that has no digit", () => {
    expect(
      findReferences(sections("A CRUK-funded study with CRUK/EPSRC support.")),
    ).toEqual([]);
  });

  it("reads a C/A pair after CRUK/ as the pair alone", () => {
    expect(findReferences(sections("Funded by CRUK/C1234/A56789."))).toEqual([
      {
        asWritten: "C1234/A56789",
        normalised: "C1234/A56789",
        format: "Cn/An",
      },
    ]);
  });

  it("leaves a run of words after CRUK/ when its digit lies past the reference", () => {
    expect(
      findReferences(
        sections("Funded by CRUK/MRC/EPSRC/NIHR/BHF/2020 grants."),
      ),
    ).toEqual([]);
  });

  // Every part after the CRUK but the last holds a digit, and no part is
  // only a year (#514). The text is made up.
  it.each([
    "Funded by CRUK/SMITH/2.",
    "Funded by CRUK (CRUK/2019).",
    "Funded by CRUK (CRUK-2019).",
    "Funded by CRUK (CRUK/12/2019).",
    "Funded by CRUK (CRUK/AB12/SMITH/2).",
    // Deeper in the form, the read does not fall back to its front.
    "Funded by CRUK (CRUK/12/34/2019).",
    "Funded by CRUK (CRUK/12/AB12/SMITH/2).",
    "Funded by CRUK (CRUK/1/2/3/SMITH/2).",
    // A later CRUK- piece takes no digit from an earlier one.
    "Funded by CRUK (CRUK/12/CRUK/AB).",
    // A last part with no digit holds at most two capitals, so a name in
    // capitals cannot end the form (#560).
    "Funded by CRUK (CRUK/12/JONES).",
    "Funded by CRUK (CRUK/12/ABC).",
    "Funded by CRUK (CRUK/1/2/3/JONES).",
    // A backslash or a spaced slash parts the form as a slash does (#598).
    String.raw`Funded by CRUK (CRUK/12\2019).`,
    "Funded by CRUK (CRUK/12 /2019).",
    "Funded by CRUK (CRUK/12/ 2019).",
    String.raw`Funded by CRUK (CRUK/12\SMITH).`,
    // A next part of nine or more capitals or digits is still a part, so
    // the read does not fall back to the front of the form (#579).
    "Funded by CRUK (CRUK/12/MCALLISTER).",
    "Funded by CRUK (CRUK/12/ABCDEFGHI).",
    "Funded by CRUK (CRUK/12/123456789).",
    "Funded by CRUK (CRUK/12/34/MCALLISTER).",
  ])(
    "leaves a CRUK- form with a part of no digit, or a part that is a year: %j",
    (text) => {
      expect(findReferences(sections(text))).toEqual([]);
    },
  );

  // A slash with a space on each side parts a list of references, not the
  // parts of one, so each reference in the list is still read (#598).
  it("reads each CRUK- form in a list parted by a slash spaced on both sides", () => {
    expect(
      findReferences(
        sections(
          "Funded by CRUK (CRUK-A12345 / CRUK-A23456).",
          "Funded by CRUK (CRUK/12345 / MRC).",
        ),
      ).map(({ asWritten }) => asWritten),
    ).toEqual(["CRUK-A12345", "CRUK-A23456", "CRUK/12345"]);
  });

  // As the model pass keeps it (#561).
  it("reads the first four parts of a CRUK- form that runs on past them", () => {
    expect(
      findReferences(sections("Funded by CRUK (CRUK/12/34/56/78/90).")),
    ).toEqual([
      {
        asWritten: "CRUK/12/34/56/78",
        normalised: "CRUK/12/34/56/78",
        format: "CRUK-X",
      },
    ]);
  });

  it("reads a CRUK- form whose last part has no digit, or holds a year and more", () => {
    expect(
      findReferences(sections("Funded by CRUK (CRUK/12/AB, CRUK-2019A).")),
    ).toEqual([
      { asWritten: "CRUK/12/AB", normalised: "CRUK/12/AB", format: "CRUK-X" },
      { asWritten: "CRUK-2019A", normalised: "CRUK-2019A", format: "CRUK-X" },
    ]);
  });

  it.each([
    "Cancer Research UK grant 12345-67.",
    "Cancer Research UK grant 12345/2.",
    "Cancer Research UK grant 12345 / 2.",
    "Cancer Research UK grant 1234.5.",
  ])("leaves a bare number that is the start of a longer one: %j", (text) => {
    expect(findReferences(sections(text))).toEqual([]);
  });

  it("lists a bare number the text ties to the funder once, beside its A number", () => {
    expect(
      findReferences(
        sections("Funded by Cancer Research UK grant A12345 (ref 12345)."),
      ),
    ).toEqual([{ asWritten: "A12345", normalised: "A12345", format: "An" }]);
    expect(
      findReferences({
        text: ["Cancer Research UK grant 12345."],
        awards: [{ sources: ["Cancer Research UK"], ids: ["A12345"] }],
      }),
    ).toEqual([{ asWritten: "A12345", normalised: "A12345", format: "An" }]);
  });

  it("lists a bare number once beside a CRUK- reference that ends in it", () => {
    expect(
      findReferences({
        text: ["Funded by Cancer Research UK (CRUK-12345)."],
        awards: [{ sources: ["Cancer Research UK"], ids: ["12345"] }],
      }),
    ).toEqual([
      { asWritten: "CRUK-12345", normalised: "CRUK-12345", format: "CRUK-X" },
    ]);
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

  // Names funder.json did not list, as gold set A's papers write them
  // (#510). "CR UK" with a space is read by the rules only.
  it.each(["Cancer Research United Kingdom", "Cancer Research U.K", "CR UK"])(
    "reads a C/A pair after %j",
    (name) => {
      expect(
        findReferences(sections(`Funded by ${name} grant C1234/A56789.`)),
      ).toEqual([
        {
          asWritten: "C1234/A56789",
          normalised: "C1234/A56789",
          format: "Cn/An",
        },
      ]);
    },
  );

  it.each(["SCR UK (C1234/A56789).", "CR UKE (C1234/A56789)."])(
    "leaves a C/A pair after CR UK inside a longer word in %j",
    (text) => {
      expect(findReferences(sections(`Funded by ${text}`))).toEqual([]);
    },
  );

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
    // Any run of whitespace, such as a line break or two spaces (#269).
    "Cancer Research\nUK",
    "Cancer  Research UK",
    "Cancer Research\u202fUK",
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

  // A letter outside A to Z is still a letter, so a name it touches is part
  // of a longer word and not the funder's (#320).
  it("leaves a G number after a name with a non-ASCII letter before it", () => {
    expect(findReferences(sections("Funded by ÉCRUK (G123/45)."))).toEqual([]);
  });

  it.each([
    ["before", "Funded by ÉCRUK (A12345)."],
    ["after", "Funded by CRUKé (A12345)."],
  ])(
    "leaves an A number when a non-ASCII letter is %s the funder's name",
    (_, text) => {
      expect(findReferences(sections(text))).toEqual([]);
    },
  );

  // A letter written as a base letter and a combining accent is still a
  // letter, and so is one the case-insensitive match folds onto a mark.
  it.each([
    ["an A number", "Funded by E\u0301CRUK (A12345)."],
    ["a G number", "Funded by E\u0301CRUK (G123/45)."],
    ["an A number after a Greek letter", "Funded by \u03b9CRUK (A12345)."],
  ])(
    "leaves %s when a letter with a combining accent or a folded case touches the name",
    (_, text) => {
      expect(findReferences(sections(text))).toEqual([]);
    },
  );

  // Chinese, Japanese and Thai put no space between words, so a Latin name
  // written straight against their letters still stands alone (#337).
  it.each([
    ["Han", "本研究由CRUK资助 (A12345)."],
    ["Hiragana", "この研究はCRUKの助成 (A12345)."],
    ["Katakana", "グラントはCRUKファンド (A12345)."],
    ["Katakana with its long vowel mark", "データーCRUKー (A12345)."],
    ["Thai", "งานนี้ได้รับทุนจากCRUKครับ (A12345)."],
    ["Lao", "ທຶນCRUKໄດ້ (A12345)."],
    ["Khmer", "ថវិកាCRUKបាន (A12345)."],
    ["Myanmar", "ငွေCRUKက (A12345)."],
  ])("reads an A number when %s letters touch the name", (_, text) => {
    expect(findReferences(sections(text))).toEqual([
      { asWritten: "A12345", normalised: "A12345", format: "An" },
    ]);
  });

  it("reads a G number after the name when a Han letter comes before it", () => {
    expect(findReferences(sections("本研究由CRUK (G123/45)."))).toEqual([
      { asWritten: "G123/45", normalised: "G123/45", format: "Gn/n" },
    ]);
  });

  it("leaves an A number when a Hangul letter touches the name", () => {
    expect(findReferences(sections("Funded by 한CRUK (A12345)."))).toEqual([]);
  });

  it("reads an A number when a non-ASCII mark that is not a letter touches the name", () => {
    expect(
      findReferences(sections("Funded by \u00abCRUK\u00bb (A12345).")),
    ).toEqual([{ asWritten: "A12345", normalised: "A12345", format: "An" }]);
  });

  // A letter outside A to Z joined to a reference makes it part of a longer
  // word, as any letter does at the funder's name (#339).
  it.each([
    ["an A number with a letter before it", "éA12345"],
    ["an A number with an accented letter before it", "e\u0301A12345"],
    ["an FC number with a letter before it", "éFC001234"],
    ["a CC number with a letter before it", "éCC2001"],
    ["an RT number with a letter before it", "éRT1234"],
    ["a coded reference with a letter before it", "éDRCMDPA/100010"],
    ["an A number with a letter after it", "A12345é"],
    ["a G number with a letter after it", "G123/45é"],
  ])("leaves %s outside A to Z", (_, reference) => {
    expect(findReferences(sections(`Funded by CRUK (${reference}).`))).toEqual(
      [],
    );
  });

  // The A part of a C/A reference stands alone after its separator, so the
  // reference sits in a sentence that does not name the funder.
  it("leaves a C/A reference with a letter outside A to Z before it", () => {
    expect(
      findReferences(sections("Funded by CRUK. Grant éC1234/A56789.")),
    ).toEqual([]);
  });

  it("leaves a bare number the text gives only with a non-ASCII letter joined to it", () => {
    expect(
      findReferences({
        text: ["Funded by the Example Trust (é12345 and 12345é)."],
        awards: [{ sources: ["Cancer Research UK"], ids: ["12345"] }],
      }),
    ).toEqual([]);
  });

  // Any decimal digit joined to a reference, not only 0 to 9, makes it part
  // of a longer number (#368).
  it.each([
    ["an Arabic-Indic digit after an A number", "A12345١"],
    ["a fullwidth digit after an A number", "A12345１"],
    ["a Devanagari digit before an A number", "१A12345"],
    ["an Arabic-Indic digit after a G number", "G123/45١"],
    ["a fullwidth digit after a C/A reference", "C1234/A56789１"],
    ["an Arabic-Indic digit after a coded reference", "DRCMDPA/100010١"],
    ["a Devanagari digit before an FC number", "१FC001234"],
    ["a fullwidth digit after a CC number", "CC2001１"],
    ["an Arabic-Indic digit after an RT number", "RT1234١"],
  ])("leaves a reference with %s", (_, reference) => {
    expect(findReferences(sections(`Funded by CRUK (${reference}).`))).toEqual(
      [],
    );
  });

  it("leaves a bare number the text gives only with a digit outside 0 to 9 joined to it", () => {
    expect(
      findReferences({
        text: ["Funded by the Example Trust (١12345 and 12345１)."],
        awards: [{ sources: ["Cancer Research UK"], ids: ["12345"] }],
      }),
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

  // A made-up name with a capital outside A to Z, as funder.json holds
  // only ASCII names today (#301).
  it("reads a G number after a non-ASCII name written in lower case", async () => {
    vi.resetModules();
    vi.doMock("./funder.json", () => ({
      default: { ...funderFile, names: ["Élan Trust"] },
    }));
    try {
      const rules = await import("./rules.ts");
      expect(
        rules.findReferences(sections("Funded by élan trust (G123/45).")),
      ).toEqual([
        { asWritten: "G123/45", normalised: "G123/45", format: "Gn/n" },
      ]);
    } finally {
      vi.doUnmock("./funder.json");
      vi.resetModules();
    }
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

  // A number the metadata gives needs the edges a model reply needs, so the
  // two passes agree: a hyphen, or a digit and a decimal point, before it
  // makes it the end of a longer one (#573). The texts are made up.
  it.each([
    ["Funded by CRUK (ABC-123456).", "123456"],
    ["Funded by CRUK grant 1.23456.", "23456"],
  ])(
    "leaves a bare number the metadata gives where the text runs into it, in %s",
    (text, id) => {
      expect(
        findReferences({
          text: [text],
          awards: [{ sources: ["Cancer Research UK"], ids: [id] }],
        }),
      ).toEqual([]);
    },
  );

  it.each([
    ["Funded by CRUK, 123456.", "123456"],
    ["Funded by CRUK (CR 234567).", "234567"],
    ["Funded by CRUK [345678].", "345678"],
    ["Funded by CRUK, award number:45678.", "45678"],
  ])(
    "reads a bare number the metadata gives after a space, a bracket or a colon, in %s",
    (text, id) => {
      expect(
        findReferences({
          text: [text],
          awards: [{ sources: ["Cancer Research UK"], ids: [id] }],
        }).map(({ normalised }) => normalised),
      ).toEqual([id]);
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

  // A paper that writes the funder's name with a no-break space may write
  // its references with one too (#269).
  it.each([
    ["A\u00a012345", "A12345"],
    ["C1234\u00a0/A12345", "C1234/A12345"],
    ["G123\u00a0/45", "G123/45"],
  ])(
    "returns only references the table accepts when %j holds a no-break space",
    (written, normalised) => {
      const found = findReferences(
        sections(`Funded by Cancer\u00a0Research\u00a0UK (${written}).`),
      );
      expect(found.map((reference) => reference.normalised)).toEqual([
        normalised,
      ]);
      for (const reference of found) {
        expect(referenceSchema.safeParse(reference).success).toBe(true);
      }
    },
  );

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

  // A bare number counts from the text alone only where the text ties it to
  // the funder (#506). These give it with no such tie.
  it.each([
    "Funded by Cancer Research UK. Sample 12345 was lost.",
    "Funded by Cancer Research UK, and the Example Trust (grant 12345).",
    "Funded by Cancer Research UK; the Example Trust gave grant 12345.",
    "Cancer Research UK funded 12345 patients.",
    "Funded by grant 12345 and by Cancer Research UK.",
  ])("leaves a bare number the text does not tie to the funder: %j", (text) => {
    expect(findReferences(sections(text))).toEqual([]);
  });

  // Another funder named after the funder's own name, with "and", "with" or
  // "&" before it, owns the number that follows (#525).
  it.each([
    "Funded by Cancer Research UK (C1234/A5678) and the Wellcome Trust (grant 203141).",
    "Supported by Cancer Research UK and the European Research Council (grant agreement No 682398).",
    "Supported by Cancer Research UK and NIH grant 123456.",
    "Supported by Cancer Research UK with the Example Trust (grant 12345).",
    "Supported by CRUK & Example Foundation grant 12345.",
    "Supported by Cancer Research UK (CRUK) and Example Trust grant 12345.",
    "Funded by Cancer Research UK Example Centre and the Sample Trust grant 12345.",
    "Funded by Cancer Research UK Programme Grant and the Example Council grant 12345.",
    "Funded by Cancer Research UK and by the Example Trust grant 12345.",
    "Funded by Cancer Research UK and from the Example Trust grant 12345.",
    "Funded by Cancer Research UK as well as the Example Trust grant 12345.",
    "Funded by Cancer Research UK and  the Example Trust grant 12345.",
    "Funded by Cancer Research UK funds  and the Example Trust grant 12345.",
    "Funded by CRUK&Example Foundation grant 12345.",
  ])("leaves a bare number after another funder's name: %j", (text) => {
    expect(
      findReferences(sections(text)).filter(({ format }) => format === "n"),
    ).toEqual([]);
  });

  it.each([
    "Supported by Cancer Research UK with grant 12345.",
    "Supported by Cancer Research UK and its grant 12345.",
    "Supported by Cancer Research UK with Grant 12345.",
    "Supported by Cancer Research UK and Project Grant 12345.",
    "Supported by Cancer Research UK with Award No. 12345.",
    "Supported by Cancer Research UK funding with Grant 12345.",
    "Cancer Research UK (CRUK) Example  and Sample Committee (Award No. 12345).",
  ])(
    "reads a bare number after a word that names no other funder: %j",
    (text) => {
      expect(findReferences(sections(text))).toEqual([
        { asWritten: "12345", normalised: "12345", format: "n" },
      ]);
    },
  );

  it("leaves a year in the funder's brackets or after a grant word", () => {
    expect(
      findReferences(
        sections("Cancer Research UK (2020) and its grant 2021 call."),
      ),
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

// The funder's names as one pattern (#271). The any-case form is built from
// each raw name, so an escape or a dash class never has its letters rewritten.
describe("the names pattern", () => {
  const whole = (pattern: string, flags = "u") =>
    new RegExp(`^(?:${pattern})$`, flags);

  it("matches a name in any case without the i flag", () => {
    const anyCase = whole(namesPattern(["Cancer Research U.K."], true));
    expect(anyCase.test("cancer RESEARCH u.k.")).toBe(true);
    expect(anyCase.test("cancer research uXk.")).toBe(false);
  });

  it("reads a hyphen in a name as any Unicode hyphen or dash", () => {
    const anyCase = whole(namesPattern(["CR-UK"], true));
    expect(anyCase.test("cr\u2010uk")).toBe(true);
    expect(anyCase.test("Cr\u2015Uk")).toBe(true);
    expect(anyCase.test("cru")).toBe(false);
  });

  it("reads any run of whitespace between the words of a name", () => {
    const anyCase = whole(namesPattern(["Cancer Research UK"], true));
    expect(anyCase.test("cancer\u00a0RESEARCH\n  uk")).toBe(true);
    expect(anyCase.test("cancerresearch uk")).toBe(false);
  });

  it("escapes every regex character in a name", () => {
    const name = "A.B*C+D?E^F$G{H}I(J)K|L[M]N\\O";
    const anyCase = whole(namesPattern([name], true));
    expect(anyCase.test(name.toLowerCase())).toBe(true);
    expect(anyCase.test("aXb*c+d?e^f$g{h}i(j)k|l[m]n\\o")).toBe(false);
  });

  it("keeps the letters' case in the plain form", () => {
    const plain = whole(namesPattern(["CRUK", "CR-UK"], false));
    expect(plain.test("CRUK")).toBe(true);
    expect(plain.test("CR\u2013UK")).toBe(true);
    expect(plain.test("cruk")).toBe(false);
  });
});
