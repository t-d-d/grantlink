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
      model: { found: new Map([["PMC5", ["A77777", "B1"]]]), spend: 0.01 },
    });
    expect(both.rows["recall-b"]).toEqual({ score: 1, n: 2 });
    // Found: C1234/A56789 by the rules, A77777 and B1 by the model.
    expect(both.rows["precision-b"]).toEqual({ score: 2 / 3, n: 2 });
  });

  it("counts a reference the rules and the model both found once", () => {
    const result = score({
      texts,
      goldA: [],
      goldB: [{ pmcid: "PMC1", references: ["C1234/A56789"] }],
      model: { found: new Map([["PMC1", ["C1234/A56789"]]]), spend: 0 },
    });
    expect(result.rows["precision-b"].score).toBe(1);
  });

  it("gives a model's spend per 1,000 papers", () => {
    const result = score({
      texts,
      goldA: [{ pmcid: "PMC1", grants: ["A56789"] }],
      goldB: [{ pmcid: "PMC2", references: ["A11111"] }],
      model: { found: new Map(), spend: 0.004 },
    });
    // $0.004 over 2 papers is $2 per 1,000.
    expect(result.rows.spend).toEqual({ score: 2, n: 2 });
  });

  it("leaves a model's spend unmeasured when it read no paper", () => {
    const result = score({
      texts,
      goldA: [],
      goldB: [],
      model: { found: new Map(), spend: 0 },
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
