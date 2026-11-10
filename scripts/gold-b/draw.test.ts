import { describe, expect, it, vi } from "vitest";
import {
  EuropePmcError,
  LARGEST_PAGE_SIZE,
  type EuropePmc,
  type SearchPage,
} from "../../src/europepmc/client.ts";
import { namesFunder } from "../../src/extract/rules.ts";
import {
  allocate,
  draw,
  HARD_CASES,
  hardCases,
  sheetCsv,
  type Plan,
} from "./draw.ts";

// Made-up papers in the JATS shape Europe PMC serves. They hold no names.
function paper(parts: { ack?: string; funding?: string; coi?: string }) {
  return [
    "<article><front><article-meta>",
    parts.funding === undefined
      ? ""
      : `<funding-group><funding-statement>${parts.funding}</funding-statement></funding-group>`,
    "</article-meta></front><back>",
    parts.ack === undefined ? "" : `<ack><p>${parts.ack}</p></ack>`,
    parts.coi === undefined
      ? ""
      : `<fn-group><fn fn-type="COI-statement"><p>${parts.coi}</p></fn></fn-group>`,
    "</back></article>",
  ].join("");
}

describe("the hard-case checks", () => {
  it("finds a declared interest in a competing-interests note", () => {
    const xml = paper({
      funding: "This work was funded by Cancer Research UK.",
      coi: "One author has received honoraria from Cancer Research UK.",
    });
    expect(hardCases(xml)).toContain("declared-interest");
  });

  it("finds no declared interest where the note does not name the funder", () => {
    const xml = paper({
      funding: "This work was funded by Cancer Research UK.",
      coi: "The authors declare no competing interests.",
    });
    expect(hardCases(xml)).not.toContain("declared-interest");
  });

  it("agrees with the rules on a name with a non-ASCII letter before it (#338)", () => {
    const note = "One author has received honoraria from \u00c9CRUK.";
    const xml = paper({
      funding: "This work was funded by Cancer Research UK.",
      coi: note,
    });
    expect(namesFunder(note)).toBe(false);
    expect(hardCases(xml)).not.toContain("declared-interest");
  });

  it("finds centre or institute support", () => {
    const xml = paper({
      ack: "We thank the Cancer Research UK Manchester Institute core facilities for their support.",
    });
    expect(hardCases(xml)).toContain("centre-or-institute");
  });

  it("finds a centre or institute named with a Unicode hyphen (#360)", () => {
    const ack =
      "We thank the CR\u2010UK Manchester Institute core facilities for their support.";
    expect(namesFunder(ack)).toBe(true);
    expect(hardCases(paper({ ack }))).toContain("centre-or-institute");
  });

  it("finds no centre or institute where a non-ASCII letter joins the name (#360)", () => {
    const ack =
      "We thank the \u00c9CRUK Manchester Institute core facilities for their support.";
    expect(namesFunder(ack)).toBe(false);
    expect(hardCases(paper({ ack }))).not.toContain("centre-or-institute");
  });

  it("reads the sentences the rules' own split gives (#360)", async () => {
    // With a split that keeps the paragraph whole, the funding word in the
    // second sentence sits beside the mention, so it is no affiliation.
    vi.resetModules();
    vi.doMock("../../src/extract/rules.ts", async (original) => ({
      ...(await original<typeof import("../../src/extract/rules.ts")>()),
      sentences: (paragraph: string) => [paragraph],
    }));
    try {
      const fresh = await import("./draw.ts");
      const ack =
        "One author is based at the CRUK Beatson Institute. The Example Trust funded this work.";
      expect(hardCases(paper({ ack }))).toContain("affiliation-only");
      expect(fresh.hardCases(paper({ ack }))).not.toContain("affiliation-only");
    } finally {
      vi.doUnmock("../../src/extract/rules.ts");
      vi.resetModules();
    }
  });

  it("finds an affiliation only, where no mention is about funding", () => {
    const xml = paper({
      ack: "One author is based at the CRUK Beatson Institute.",
    });
    expect(hardCases(xml)).toContain("affiliation-only");
    expect(hardCases(paper({ ack: "Funded by CRUK." }))).not.toContain(
      "affiliation-only",
    );
  });

  it("finds several funders", () => {
    const xml = paper({
      funding:
        "Supported by Cancer Research UK and the Medical Research Council.",
    });
    expect(hardCases(xml)).toContain("several-funders");
    expect(
      hardCases(paper({ funding: "Supported by Cancer Research UK." })),
    ).not.toContain("several-funders");
  });

  it("finds the funder named as a funder with no reference", () => {
    expect(
      hardCases(paper({ funding: "Supported by Cancer Research UK." })),
    ).toContain("no-reference");
    expect(
      hardCases(
        paper({ funding: "Supported by Cancer Research UK (C1234/A12345)." }),
      ),
    ).not.toContain("no-reference");
  });
});

describe("allocating the sample across years", () => {
  it("shares the size in proportion, and gives the exact total", () => {
    const shares = allocate({ "2020": 300, "2021": 200, "2022": 100 }, 10);
    expect(shares).toEqual({ "2020": 5, "2021": 3, "2022": 2 });
  });

  it("breaks ties by the larger remainder, then by year", () => {
    const shares = allocate({ "2020": 1, "2021": 1, "2022": 1 }, 2);
    expect(shares).toEqual({ "2020": 1, "2021": 1, "2022": 0 });
    expect(Object.values(allocate({ a: 7, b: 5, c: 3 }, 11))).toEqual([
      5, 4, 2,
    ]);
  });
});

// A fake Europe PMC that answers each query from a table, one page each.
function fake(
  hits: Record<string, { pmcid: string; year: string }[]>,
  texts: Record<string, string>,
  failing: Record<string, Error> = {},
) {
  const fetched: string[] = [];
  const searched: string[] = [];
  const sizes: (number | undefined)[] = [];
  const api: EuropePmc = {
    sent: () => fetched.length + searched.length,
    search(_cursor, selection = "", pageSize?: number): Promise<SearchPage> {
      searched.push(selection);
      sizes.push(pageSize);
      const found = hits[selection];
      if (found === undefined) throw new Error(`unexpected query ${selection}`);
      return Promise.resolve({
        hitCount: found.length,
        nextCursor: null,
        skipped: 0,
        papers: found.map(({ pmcid, year }) => ({
          pmcid,
          title: "",
          firstPublished: `${year}-06-01`,
        })),
      });
    },
    fullText(pmcid) {
      fetched.push(pmcid);
      const failure = failing[pmcid];
      if (failure !== undefined) return Promise.reject(failure);
      const text = texts[pmcid];
      return text === undefined
        ? Promise.reject(new EuropePmcError("Europe PMC answered 404", 404))
        : Promise.resolve(text);
    },
    grants: () => Promise.resolve([]),
  };
  return { api, fetched, searched, sizes };
}

describe("drawing the sample", () => {
  const base = "BASE";
  const plan: Plan = {
    base,
    seed: 11,
    size: 8,
    perHardCase: 1,
    hardCases: HARD_CASES.map((name) => ({ name, query: `${name}-Q` })),
  };
  const all = Array.from({ length: 40 }, (_, i) => ({
    pmcid: `PMC${String(i + 1)}`,
    year: i < 30 ? "2020" : "2021",
  }));
  const plain = paper({ funding: "Funded by Cancer Research UK C1/A12345." });
  const texts: Record<string, string> = Object.fromEntries(
    all.map(({ pmcid }) => [pmcid, plain]),
  );
  texts.PMC1 = paper({
    funding: "Funded by Cancer Research UK C1/A12345.",
    coi: "An author consults for Cancer Research UK.",
  });
  texts.PMC2 = paper({ ack: "We thank the CRUK Cambridge Institute." });
  texts.PMC3 = paper({
    ack: "One author works at the CRUK Beatson Institute.",
  });
  texts.PMC4 = paper({
    funding: "Funded by Cancer Research UK C1/A12345 and Wellcome.",
  });
  texts.PMC5 = paper({ funding: "Funded by Cancer Research UK." });
  const hits = {
    [base]: all,
    "declared-interest-Q": all.slice(0, 1),
    "centre-or-institute-Q": all.slice(1, 2),
    "affiliation-only-Q": all.slice(2, 3),
    "several-funders-Q": all.slice(0, 4),
    "no-reference-Q": all,
  };

  it("takes each hard case, then fills by year, and repeats exactly", async () => {
    const first = await draw(fake(hits, texts).api, plan);
    const again = await draw(fake(hits, texts).api, plan);
    expect(again).toEqual(first);
    expect(first.papers).toHaveLength(8);
    expect(new Set(first.papers.map((p) => p.pmcid)).size).toBe(8);
    const picked = Object.fromEntries(
      first.papers
        .filter((p) => p.pickedFor !== "year")
        .map((p) => [p.pickedFor, p.pmcid]),
    );
    expect(picked).toEqual({
      "declared-interest": "PMC1",
      "centre-or-institute": "PMC2",
      "affiliation-only": "PMC3",
      "several-funders": "PMC4",
      "no-reference": "PMC5",
    });
    const fill = first.papers.filter((p) => p.pickedFor === "year");
    expect(fill).toHaveLength(3);
    expect(fill.filter((p) => p.year === "2020")).toHaveLength(2);
    expect(fill.filter((p) => p.year === "2021")).toHaveLength(1);
  });

  it("searches a query the plan repeats only once", async () => {
    const repeated = {
      ...plan,
      hardCases: plan.hardCases.map((hardCase) =>
        hardCase.name === "no-reference"
          ? { ...hardCase, query: base }
          : hardCase,
      ),
    };
    const { api, searched } = fake(hits, texts);
    await draw(api, repeated);
    expect(searched.filter((query) => query === base)).toHaveLength(1);
  });

  it("asks for Europe PMC's largest page, as the pace makes each page slow", async () => {
    const { api, sizes } = fake(hits, texts);
    await draw(api, plan);
    expect(new Set(sizes)).toEqual(new Set([LARGEST_PAGE_SIZE]));
  });

  it("orders the sheet by the seed, not by how each paper was picked", async () => {
    const { papers, sheetOrder } = await draw(fake(hits, texts).api, plan);
    expect(new Set(sheetOrder)).toEqual(new Set(papers.map((p) => p.pmcid)));
    expect(sheetOrder).not.toEqual(papers.map((p) => p.pmcid));
  });

  it("reads each paper's full text once, though two hard cases share a query", async () => {
    const shared = {
      ...plan,
      hardCases: plan.hardCases.map((hardCase) =>
        hardCase.name === "several-funders" || hardCase.name === "no-reference"
          ? { ...hardCase, query: base }
          : hardCase,
      ),
    };
    const { api, fetched } = fake(hits, texts);
    await draw(api, shared);
    expect(fetched.length).toBeGreaterThan(0);
    expect(new Set(fetched).size).toBe(fetched.length);
  });

  it("passes over a paper with no full text", async () => {
    const missing = { ...texts };
    delete missing.PMC1;
    const thin = { ...hits, "declared-interest-Q": all.slice(0, 1) };
    await expect(draw(fake(thin, missing).api, plan)).rejects.toThrow(
      /declared-interest: found 0/u,
    );
  });

  it("stops, rather than passing over a paper, when Europe PMC fails", async () => {
    const { api } = fake(hits, texts, {
      PMC1: new EuropePmcError(
        "Europe PMC answered 503, after 5 tries",
        undefined,
      ),
    });
    await expect(draw(api, plan)).rejects.toThrow(/503/u);
  });

  it("fails when the plan's size is less than its hard cases take", async () => {
    await expect(
      draw(fake(hits, texts).api, { ...plan, size: 4 }),
    ).rejects.toThrow(/size/u);
  });

  it("fails when a hard case has too few papers", async () => {
    const thin = { ...hits, "declared-interest-Q": all.slice(5, 6) };
    await expect(draw(fake(thin, texts).api, plan)).rejects.toThrow(
      /declared-interest/u,
    );
  });

  it("refuses a hard case that is not the base query's", async () => {
    const stray = {
      ...hits,
      "declared-interest-Q": [{ pmcid: "PMC999", year: "2020" }],
    };
    await expect(draw(fake(stray, texts).api, plan)).rejects.toThrow(/PMC999/u);
  });
});

describe("the labelling sheet", () => {
  it("has a row per paper with its link and empty label columns", () => {
    expect(sheetCsv(["PMC7", "PMC3"]).split("\n")).toEqual([
      "pmcid,europe_pmc,funded,references_as_written,references_normalised,note",
      "PMC7,https://europepmc.org/article/PMC/PMC7,,,,",
      "PMC3,https://europepmc.org/article/PMC/PMC3,,,,",
      "",
    ]);
  });
});
