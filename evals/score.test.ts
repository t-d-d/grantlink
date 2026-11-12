import { describe, expect, it } from "vitest";
import type { FundingSections } from "../src/extract/rules.ts";
import { crukReference, printedGrants, sameGrant, score } from "./score.ts";

const paper = (text: string[], awards: FundingSections["awards"] = []) => ({
  text,
  awards,
});

describe("matching a reference to Europe PMC's grant id", () => {
  it.each([
    ["C1234/A56789", "C1234/A56789"],
    ["C1234/A56789", "A56789"],
    ["A56789", "C1234/A56789"],
    ["A56789", "56789"],
    // A reference whose own form starts with CRUK- or CRUK/ keeps it when
    // normalised, and Europe PMC may hold it with or without (#506).
    ["CRUK-A12345", "A12345"],
    ["CRUK-A12345", "12345"],
    ["A12345", "CRUK-A12345"],
    ["CRUK/C1234/A56789", "C1234/A56789"],
    ["CTRQQR-2021/100010", "CTRQQR-2021\\100010"],
    ["CTRQQR-2021/100010", "ctrqqr-2021 / 100010"],
    ["A17196", "A17196/"],
    ["17196", "A17196\\"],
    ["PRCRPG-NOV21/100001", "PRCRPG-Nov21\\\\100001"],
  ])("%s matches %s", (found, expected) => {
    expect(sameGrant(found, expected)).toBe(true);
  });

  it.each([
    ["C1234/A56789", "A56780"],
    ["A56789", "C1234"],
    ["CTRQQR-2021/100010", "100010"],
    ["CRUK/12/034", "12/034"],
    ["CRUKDF-0123-AB", "DF-0123-AB"],
  ])("%s does not match %s", (found, expected) => {
    expect(sameGrant(found, expected)).toBe(false);
  });
});

// What a paper prints decides gold set A's answers (#502): a linked grant
// counts only if one of the forms sameGrant accepts stands alone in the
// whole article, ignoring case and spaces.
// Only a reference in a CRUK form can be gold set A's answer (#503).
describe("telling a CRUK reference from another linked id", () => {
  it.each([
    "C1234/A56789",
    "C1234\\A56789",
    "c1234 / a56789",
    "A56789",
    "56789",
    "1234",
    "A123456",
    "FC001234",
    "CC2009",
    "CTRQQR-2021\\100010",
    "RRCOER-Jun24/100008",
    "DRCPGM\\100015",
    "EDDCPJT\\100018",
    "A17196/",
    "A21139\\",
    "PRCRPG-Nov21\\\\100001",
    "CRUK-C5759",
    // A CRUK id the rules read, which only their shape check takes (#575).
    "CRUK/12345",
    "CRUK-Nov21/100001",
    // A month written straight onto the code, as the rules read it.
    "CTRQQRMar21/100010",
    "DRCDDRPGMApr2020\\100002",
    // A code at the edges the rules allow: 4 and 12 capitals, and a
    // suffix of 8 (#583).
    "ABCD/100010",
    "ABCDEFGHIJKL/100010",
    "ABCD-ABCDEFGH/100010",
  ])("takes %s", (id) => {
    expect(crukReference(id)).toBe(true);
  });

  it.each([
    "C5759",
    "204826/Z/16/Z",
    "Prominent",
    "123",
    "1234567",
    "A1234567",
    "MR/T001234/1",
    "FC",
    "SP2312/021",
    "CTR-Q5-Y3",
    "RG86786",
    "CRUK",
    "CRUK/",
    "cruk",
    "CRUK-",
    "CRUK\\",
    "CRUK_Manchester",
    "CRUK/MRC",
    "CRUK-FUNDED",
    "CRUK-MI",
    "CRUK/MRC/EPSRC/NIHR/BHF/2020",
    "CRUK2019",
    "CRUK_2019",
    "CRUK.12345",
    // A part before the last with no digit (#514).
    "CRUK-UCL-2023",
    "CRUK/SMITH/2",
    // A year alone after CRUK, which the rules refuse since #514 (#575).
    "CRUK/2019",
    "CRUK-2019/12345",
    // A code the rules refuse: too few capitals, a number not of six digits
    // starting with 1, too many capitals, or a year with no hyphen (#583).
    "ABC/2019",
    "DRCPGM/1",
    "DRCPGM/200015",
    "DRCPGM/1000150",
    "ABCDEFGHIJKLM/100010",
    "CTRQQR2021/100010",
    // A suffix of 9 (#583).
    "ABCD-ABCDEFGHI/100010",
  ])("refuses %s", (id) => {
    expect(crukReference(id)).toBe(false);
  });
});

describe("finding which linked grants a paper prints", () => {
  it.each([
    ["C1234/A56789", "<p>Funded by CRUK (C1234/A56789).</p>"],
    ["C1234/A56789", "<p>Funded by grant A56789.</p>"],
    ["C1234/A56789", "<p>Funded by grant 56789.</p>"],
    ["A56789", "<p>Funded by C1234/A56789.</p>"],
    ["A56789", "<p>grant a 56789</p>"],
    ["C1234/A56789", "<p>c1234 \\ a56789</p>"],
    ["CTRQQR-2021/100010", "<p>ctrqqr-2021 / 100010</p>"],
    ["A56789", "<award-id>A56789</award-id>"],
    ["A56789", "<p>grant A<italic>56789</italic></p>"],
    ["A17196/", "<p>Funded by grant A17196.</p>"],
    ["PRCRPG-Nov21\\\\100001", "<p>PRCRPG-Nov21\\100001</p>"],
    ["C1/A23456", "<p>Funded by grant 23456.</p>"],
    ["A12345", "<p>Grants 12345-A23456.</p>"],
    ["A2019", "<p>Funded by Cancer Research UK grant 2019.</p>"],
    ["A2019", "<p>Grant 2019 from CRUK.</p>"],
    ["A2019", "<p>Recruited in 2019. Funded by grant A2019.</p>"],
    ["A1234", "<p>Recruited with grant 1234.</p>"],
    // A DOI ends at a space, so a grant after it still reads (#597).
    ["A12345", "<p>Data at 10.7554/eLife.1. Funded by grant 12345.</p>"],
    // A DOI also ends at a character no DOI holds, such as a comma or the
    // ampersand that starts an entity (#597).
    ["A12345", "<p>Cancer Research UK (10.13039/501100000289,12345)</p>"],
    ["A12345", "<p>Data at 10.5061/dryad.1&#x000a0;12345.</p>"],
    // A year reads near any name the rules read for the funder (#520).
    ["A2019", "<p>Funded by Cancer Research U.K. grant 2019.</p>"],
    ["A2019", "<p>Funded by CR-UK grant 2019.</p>"],
    // Indentation between tags does not push a year away from the name.
    [
      "A2019",
      "<funding-source>\n                    <institution-wrap>\n                      <institution>Cancer Research UK</institution>\n                    </institution-wrap>\n                  </funding-source>\n                  <award-id>2019</award-id>",
    ],
  ])("finds %s printed in %s", (grant, article) => {
    expect(printedGrants([grant], article)).toEqual([grant]);
  });

  it.each([
    ["A56789", "<p>No grant here.</p>"],
    ["A56789", "<p>Order 1567890 arrived.</p>"],
    ["A56789", "<p>Grant B56789.</p>"],
    ["A56789", "<p>Grant A567890.</p>"],
    ["C1234/A56789", "<p>Programme C1234.</p>"],
    ["A12345", "<p>Figure 1 2345 cells.</p>"],
    ["A12345", "<table><tr><td>1</td><td>2345</td></tr></table>"],
    // A bare number with a dot or a hyphen and a digit beside it sits in
    // a decimal or a DOI (#520).
    ["C1/A23456", "<p>The ratio was 1.23456 overall.</p>"],
    ["A12345", "<p>doi.org/10.1038/s41467-020-12345-6</p>"],
    ["A12345", "<p>Version 12345.6 of the tool.</p>"],
    ["A12345", "<p>Samples 4-12345 were run.</p>"],
    // A middle dot can write a decimal, and a dash the rules read as a
    // hyphen can write a range or a DOI (#556).
    ["C1/A23456", "<p>The ratio was 1·23456 overall.</p>"],
    ["A12345", "<p>Pages 4–12345.</p>"],
    ["A12345", "<p>Version 12345·6 of the tool.</p>"],
    ["A12345", "<p>Samples 12345—6 were run.</p>"],
    ["A12345", "<p>Samples 4−12345 were run.</p>"],
    // A DOI whose last part is letters, a dot and the number, as eLife's
    // are, still holds the number (#597).
    [
      "A12345",
      "<article><body><p>Data at https://doi.org/10.7554/eLife.12345</p></body></article>",
    ],
    ["A12345", "<p>See DOI 10.7554/ELIFE.12345.sa1 for the review.</p>"],
    // A bare number that reads as a year counts only near CRUK (#520).
    ["A2019", "<p>Recruited in 2019.</p>"],
    [
      "A2019",
      "<p>Funded by Cancer Research UK. Patients were recruited between the spring and the autumn of the year 2019.</p>",
    ],
  ])("does not find %s printed in %s", (grant, article) => {
    expect(printedGrants([grant], article)).toEqual([]);
  });

  it("does not count a grant that appears only in the reference list", () => {
    expect(
      printedGrants(
        ["A11111", "A22222"],
        "<article><body><p>Grant A11111.</p></body><back><ref-list><ref>Grant A22222 report.</ref></ref-list></back></article>",
      ),
    ).toEqual(["A11111"]);
  });

  // The front matter is the article's metadata, so only its funding group
  // is read (#555).
  it.each([
    [
      "A12345",
      "a journal's own DOI",
      '<article><front><article-meta><article-id pub-id-type="doi">10.7554/eLife.12345</article-id></article-meta></front><body><p>No grant here.</p></body></article>',
    ],
    [
      "A2021",
      "a copyright line",
      "<article><front><article-meta><permissions><copyright-statement>Published under exclusive licence to Cancer Research UK 2021</copyright-statement></permissions></article-meta></front><body><p>No grant here.</p></body></article>",
    ],
    [
      "A12345",
      "a sub-article's own DOI",
      '<article><body><p>No grant here.</p></body><sub-article><front-stub><article-id pub-id-type="doi">10.7554/eLife.12345.sa1</article-id></front-stub><body><p>A review.</p></body></sub-article></article>',
    ],
  ])(
    "does not find %s printed in the front matter's %s",
    (grant, _what, article) => {
      expect(printedGrants([grant], article)).toEqual([]);
    },
  );

  it.each([
    [
      "A12345",
      "<article><front><article-meta><funding-group><award-group><funding-source>Cancer Research UK</funding-source><award-id>A12345</award-id></award-group></funding-group></article-meta></front><body><p>No grant here.</p></body></article>",
    ],
    [
      "A2021",
      "<article><front><article-meta><funding-group><award-group><funding-source>Cancer Research UK</funding-source><award-id>2021</award-id></award-group></funding-group></article-meta></front><body><p>No grant here.</p></body></article>",
    ],
    [
      "A12345",
      "<article><body><p>No grant here.</p></body><sub-article><front-stub><funding-group><award-group><award-id>A12345</award-id></award-group></funding-group></front-stub></sub-article></article>",
    ],
  ])(
    "finds %s printed in the front matter's funding group",
    (grant, article) => {
      expect(printedGrants([grant], article)).toEqual([grant]);
    },
  );

  // The cutter keeps a funding footnote in the author notes, so the
  // answers read it too.
  it("finds a grant printed in a funding footnote in the front matter's author notes", () => {
    expect(
      printedGrants(
        ["A12345"],
        '<article><front><article-meta><author-notes><fn fn-type="financial-disclosure"><p>Funded by grant A12345.</p></fn></author-notes></article-meta></front><body><p>No grant here.</p></body></article>',
      ),
    ).toEqual(["A12345"]);
  });

  // An empty funding group does not keep the metadata after it.
  it("does not read past an empty funding group in the front matter", () => {
    expect(
      printedGrants(
        ["A12345"],
        '<article><front><article-meta><funding-group /><article-id pub-id-type="doi">10.7554/eLife.12345</article-id><funding-group><funding-statement>None.</funding-statement></funding-group></article-meta></front><body><p>No grant here.</p></body></article>',
      ),
    ).toEqual([]);
  });

  it("keeps only the linked grants the paper prints, in their order", () => {
    expect(
      printedGrants(
        ["A11111", "A22222", "C3/A33333"],
        "<p>Grants 33333 and A11111.</p>",
      ),
    ).toEqual(["A11111", "C3/A33333"]);
  });
});

describe("scoring the rules on the gold sets", () => {
  const texts = new Map([
    ["PMC1", paper(["Funded by Cancer Research UK (C1234/A56789)."])],
    ["PMC2", paper(["We thank Cancer Research UK for grant A11111."])],
    ["PMC3", paper(["Funded by the Wellcome Trust."])],
    ["PMC4", paper(["Cancer Research UK grant A22222 and C9/A33333."])],
  ]);

  it("scores recall on gold set A against Europe PMC's links, and names the papers it missed", () => {
    const result = score({
      texts,
      goldA: [
        { pmcid: "PMC1", grants: ["A56789"] },
        { pmcid: "PMC2", grants: ["A11111", "A99999"] },
        { pmcid: "PMC3", grants: ["A12345"] },
      ],
      goldB: [],
    });
    expect(result.rows["recall-a"]).toEqual({ score: 2 / 4, n: 3 });
    expect(result.missedA).toEqual(["PMC2", "PMC3"]);
  });

  it("scores precision and recall on gold set B against the owner's labels", () => {
    const result = score({
      texts,
      goldA: [],
      goldB: [
        { pmcid: "PMC1", references: ["C1234/A56789"] },
        { pmcid: "PMC3", references: [] },
        { pmcid: "PMC4", references: ["A22222"] },
      ],
    });
    // Found: C1234/A56789, A22222, C9/A33333. Two of three are true, and
    // both true references are found.
    expect(result.rows["precision-b"]).toEqual({ score: 2 / 3, n: 3 });
    expect(result.rows["recall-b"]).toEqual({ score: 1, n: 3 });
  });

  it("leaves a row with no gold papers empty, so it does not block", () => {
    const result = score({ texts: new Map(), goldA: [], goldB: [] });
    expect(result.rows["recall-a"].score).toBeNull();
    expect(result.rows["precision-b"].score).toBeNull();
    expect(result.rows["recall-b"].score).toBeNull();
    expect(result.rows["model-adds"].score).toBeNull();
    expect(result.rows["review-share"].score).toBeNull();
  });

  it("spends nothing, since only the rules run", () => {
    expect(score({ texts, goldA: [], goldB: [] }).rows.spend.score).toBe(0);
  });

  it("scores the rules with a model's references added", () => {
    // The rules find nothing in PMC5. The model finds its reference.
    const withPMC5 = new Map([
      ...texts,
      ["PMC5", paper(["Funded by CRUK award ref X1."])],
    ]);
    const goldB = [
      { pmcid: "PMC1", references: ["C1234/A56789"] },
      { pmcid: "PMC5", references: ["A77777"] },
    ];
    const rules = score({ texts: withPMC5, goldA: [], goldB });
    expect(rules.rows["recall-b"].score).toBe(1 / 2);
    const both = score({
      texts: withPMC5,
      goldA: [],
      goldB,
      model: {
        found: new Map([["PMC5", ["A77777", "B1"]]]),
        spend: 0.01,
        unprocessed: [],
      },
    });
    expect(both.rows["recall-b"]).toEqual({ score: 1, n: 2 });
    // Found: C1234/A56789 by the rules, A77777 and B1 by the model.
    expect(both.rows["precision-b"]).toEqual({ score: 2 / 3, n: 2 });
  });

  it("scores a model alone, counting only its references, on both gold sets", () => {
    // The rules find C1234/A56789 in PMC1 and A22222 in PMC4. The model,
    // alone, finds A77777 in PMC5 and a wrong B1 in PMC1, and nothing else.
    const withPMC5 = new Map([
      ...texts,
      ["PMC5", paper(["Funded by CRUK award ref X1."])],
    ]);
    const result = score({
      texts: withPMC5,
      goldA: [
        { pmcid: "PMC1", grants: ["A56789"] },
        { pmcid: "PMC5", grants: ["A77777"] },
      ],
      goldB: [
        { pmcid: "PMC1", references: ["C1234/A56789"] },
        { pmcid: "PMC4", references: ["A22222"] },
        { pmcid: "PMC5", references: ["A77777"] },
      ],
      model: {
        found: new Map([
          ["PMC1", ["B1"]],
          ["PMC5", ["A77777"]],
        ]),
        spend: 0.005,
        unprocessed: [],
      },
      rules: false,
    });
    expect(result.rows["recall-a"]).toEqual({ score: 1 / 2, n: 2 });
    expect(result.missedA).toEqual(["PMC1"]);
    // Found in gold set B: B1 and A77777, one of them true, and one of the
    // three true references.
    expect(result.rows["precision-b"]).toEqual({ score: 1 / 2, n: 3 });
    expect(result.rows["recall-b"]).toEqual({ score: 1 / 3, n: 3 });
    expect(result.rows["model-adds"].score).toBeNull();
    // $0.005 over 5 papers is $1 per 1,000, the model's own spend.
    expect(result.rows.spend.score).toBeCloseTo(1);
  });

  describe("a paper the model left unread (#696)", () => {
    // The model reads PMC1, where it finds the grant, and leaves PMC2 and
    // PMC4 unread. The rules find a grant in each of the three.
    const goldA = [
      { pmcid: "PMC1", grants: ["A56789"] },
      { pmcid: "PMC2", grants: ["A11111"] },
    ];
    const goldB = [
      { pmcid: "PMC1", references: ["C1234/A56789"] },
      { pmcid: "PMC4", references: ["A22222"] },
    ];
    const model = {
      found: new Map([["PMC1", ["C1234/A56789"]]]),
      spend: 0.004,
      unprocessed: ["PMC2", "PMC4"],
    };

    it("is out of the model's precision and recall alone, on every gold set", () => {
      const result = score({ texts, goldA, goldB, model, rules: false });
      expect(result.rows["recall-a"]).toEqual({ score: 1, n: 1 });
      expect(result.rows["precision-b"]).toEqual({ score: 1, n: 1 });
      expect(result.rows["recall-b"]).toEqual({ score: 1, n: 1 });
      expect(result.missedA).toEqual([]);
    });

    it("scores the rules' references when the rules come first", () => {
      const result = score({ texts, goldA, goldB, model });
      expect(result.rows["recall-a"]).toEqual({ score: 1, n: 2 });
      expect(result.rows["recall-b"]).toEqual({ score: 1, n: 2 });
      // PMC4's C9/A33333 is found by the rules and is not a true reference.
      expect(result.rows["precision-b"]).toEqual({ score: 2 / 3, n: 2 });
    });

    it("gives the model alone no score on a gold set it read none of", () => {
      const result = score({
        texts,
        goldA: [{ pmcid: "PMC2", grants: ["A11111"] }],
        goldB: [{ pmcid: "PMC4", references: ["A22222"] }],
        model,
        rules: false,
      });
      expect(result.rows["recall-a"]).toEqual({ score: null, n: 0 });
      expect(result.rows["precision-b"]).toEqual({ score: null, n: 0 });
      expect(result.rows["recall-b"]).toEqual({ score: null, n: 0 });
    });

    it("still counts in the spend, read or not", () => {
      // $0.004 over the 4 gold papers sent is $1 per 1,000.
      for (const rules of [true, false]) {
        const result = score({ texts, goldA, goldB, model, rules });
        expect(result.rows.spend.n).toBe(4);
        expect(result.rows.spend.score).toBeCloseTo(1);
      }
    });
  });

  it("counts a reference the rules and the model both found once", () => {
    const result = score({
      texts,
      goldA: [],
      goldB: [{ pmcid: "PMC1", references: ["C1234/A56789"] }],
      model: {
        found: new Map([["PMC1", ["C1234/A56789"]]]),
        spend: 0,
        unprocessed: [],
      },
    });
    expect(result.rows["precision-b"].score).toBe(1);
  });

  it("gives a model's spend per 1,000 papers", () => {
    const result = score({
      texts,
      goldA: [{ pmcid: "PMC1", grants: ["A56789"] }],
      goldB: [{ pmcid: "PMC2", references: ["A11111"] }],
      model: { found: new Map(), spend: 0.004, unprocessed: [] },
    });
    // $0.004 over 2 papers is $2 per 1,000.
    expect(result.rows.spend).toEqual({ score: 2, n: 2 });
  });

  it("leaves a model's spend unmeasured when it read no paper", () => {
    const result = score({
      texts,
      goldA: [],
      goldB: [],
      model: { found: new Map(), spend: 0, unprocessed: [] },
    });
    expect(result.rows.spend.score).toBeNull();
  });

  it("refuses to score a gold paper whose text is missing", () => {
    expect(() =>
      score({
        texts,
        goldA: [{ pmcid: "PMC9", grants: ["A1"] }],
        goldB: [],
      }),
    ).toThrow(/PMC9/u);
  });
});
