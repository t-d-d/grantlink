import { describe, expect, it } from "vitest";
import {
  agreedSample,
  csv,
  flagsFor,
  guideNormalise,
  NOT_CHECKED,
  parseCsv,
  passesFor,
  type Pass,
} from "./flags.ts";

const pass = (over: Partial<Pass> = {}): Pass => ({
  funded: "yes",
  references: ["C1234/A56789"],
  unsure: false,
  ...over,
});

const MODEL = "anthropic/claude-haiku-5.5";

describe("guideNormalise", () => {
  it("normalises as the rules do", () => {
    expect(guideNormalise("c 1234 \\ a56789")).toBe("C1234/A56789");
    expect(guideNormalise("ABCDE‐Jun24/100003")).toBe("ABCDE-JUN24/100003");
  });

  it("drops a CRUK joined straight onto the front, as the guide does", () => {
    expect(guideNormalise("CRUKC1234/A56789")).toBe("C1234/A56789");
  });

  it("keeps a CRUK/ or CRUK- that is the reference's own form", () => {
    expect(guideNormalise("CRUK/12/345")).toBe("CRUK/12/345");
    expect(guideNormalise("CRUK-A12345")).toBe("CRUK-A12345");
  });
});

describe("passesFor", () => {
  it("says the passes agreed when they gave the same labels", () => {
    expect(passesFor([pass(), pass()])).toBe("passes agreed");
  });

  it("names each way they differed, and an unsure pass", () => {
    expect(
      passesFor([
        pass({ funded: "no", references: [] }),
        pass({ unsure: true }),
      ]),
    ).toBe(
      "passes differed on funded; passes differed on references; a pass was unsure",
    );
  });

  it("compares references as sets, in any order", () => {
    expect(
      passesFor([
        pass({ references: ["A1", "B2"] }),
        pass({ references: ["B2", "A1", "A1"] }),
      ]),
    ).toBe("passes agreed");
  });
});

describe("flagsFor", () => {
  const agreed = {
    passes: [pass(), pass()] as const,
    rules: ["C1234/A56789"],
    models: { [MODEL]: ["C1234/A56789"] },
  };

  it("gives no reason when everyone agrees", () => {
    expect(flagsFor(["C1234/A56789"], agreed)).toEqual([]);
  });

  it("gives every reason a row is checked, and never the reference", () => {
    expect(
      flagsFor(["C1234/A56789"], {
        passes: [pass({ unsure: true }), pass({ references: [] })],
        rules: [],
        models: { [MODEL]: ["C1234/A56789", "C9999/A99999"] },
      }),
    ).toEqual([
      "passes differ",
      "a pass was unsure",
      "differs from the rules",
      `differs from ${MODEL} alone`,
    ]);
  });

  it("flags a difference in funded alone as the passes differing", () => {
    expect(
      flagsFor(["C1234/A56789"], {
        ...agreed,
        passes: [pass(), pass({ funded: "unclear" })],
      }),
    ).toEqual(["passes differ"]);
  });
});

describe("agreedSample", () => {
  const rows = [
    { pmcid: "PMC1", reasons: [] },
    { pmcid: "PMC2", reasons: ["passes differ"] },
    { pmcid: "PMC3", reasons: [] },
    { pmcid: "PMC4", reasons: [] },
  ];

  it("draws only from rows with no other reason, the same way each time", () => {
    const drawn = agreedSample(rows, 7, 2);
    expect(drawn).toHaveLength(2);
    expect(drawn).not.toContain("PMC2");
    expect(agreedSample(rows, 7, 2)).toEqual(drawn);
  });

  it("takes every agreed row when there are fewer than asked", () => {
    expect(agreedSample(rows, 7, 10).sort()).toEqual(["PMC1", "PMC3", "PMC4"]);
  });

  it("names the label for an agreed row the sample did not draw", () => {
    expect(NOT_CHECKED).toBe("agreed, not checked");
  });
});

describe("csv", () => {
  it("quotes a cell with a comma or a quote, and reads it back", () => {
    const rows = [
      ["a", "b, c", 'say "hi"'],
      ["", "x", "y"],
    ];
    const text = csv(rows);
    expect(text).toBe('a,"b, c","say ""hi"""\n,x,y\n');
    expect(parseCsv(text)).toEqual(rows);
  });
});
