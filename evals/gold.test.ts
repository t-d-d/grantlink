import { describe, expect, it } from "vitest";
import {
  goldA,
  goldA2,
  goldB,
  goldBLabels,
  manifest,
  paperFile,
  pinned,
} from "./gold.ts";

describe("the gold sets and the pin", () => {
  it("records gold set A's query, seed and size", () => {
    expect(goldA.query).toContain('GRANT_AGENCY:"Cancer Research UK"');
    expect(goldA.query).toMatch(/FIRST_PDATE:\[\S+ TO \d{4}-\d{2}-\d{2}\]/u);
    expect(goldA.size).toBe(300);
    expect(Number.isInteger(goldA.seed)).toBe(true);
  });

  it("records gold set A2's draw: gold set A's query, its own seed, and 300 papers", () => {
    expect(goldA2.query).toBe(goldA.query);
    expect(goldA2.size).toBe(300);
    expect(Number.isInteger(goldA2.seed)).toBe(true);
    expect(goldA2.seed).not.toBe(goldA.seed);
  });

  it("keeps no gold set A paper in gold set A2", () => {
    const inA = new Set(goldA.papers.map((paper) => paper.pmcid));
    expect(goldA2.papers.filter((paper) => inA.has(paper.pmcid))).toEqual([]);
  });

  it("names the snapshot, pinned or not yet", () => {
    expect(pinned.id).toMatch(/^s\d+$/u);
    expect(
      pinned.manifestSha256 === null ||
        /^[0-9a-f]{64}$/u.test(pinned.manifestSha256),
    ).toBe(true);
  });

  it("refuses gold set B labels that carry anything but ids and references", () => {
    const paper = { pmcid: "PMC1", references: ["C1234/A56789"] };
    const file = { about: "x", papers: [paper] };
    expect(goldBLabels.parse(file)).toEqual(file);
    expect(goldBLabels.parse(goldB)).toEqual(goldB);
    // A note or the funded column, beside the references.
    expect(() =>
      goldBLabels.parse({ ...file, papers: [{ ...paper, note: "x" }] }),
    ).toThrow();
    expect(() =>
      goldBLabels.parse({ ...file, papers: [{ ...paper, funded: "yes" }] }),
    ).toThrow();
    // A sentence or a name in place of a reference.
    expect(() =>
      goldBLabels.parse({
        ...file,
        papers: [{ ...paper, references: ["Funded by Dr Jane Doe"] }],
      }),
    ).toThrow();
  });

  it("refuses a manifest entry that carries anything but ids, hashes and grant ids", () => {
    const entry = {
      pmcid: "PMC1",
      set: "A",
      sha256: "a".repeat(64),
      grants: ["C1234/A56789"],
    };
    const base = {
      id: "s1",
      createdAt: "2026-11-09T12:00:00.000Z",
      goldA: { query: goldA.query, seed: goldA.seed, size: goldA.size },
      papers: [entry],
    };
    expect(manifest.parse(base)).toEqual(base);
    expect(() =>
      manifest.parse({ ...base, papers: [{ ...entry, text: "x" }] }),
    ).toThrow();
    expect(() =>
      manifest.parse({
        ...base,
        papers: [{ ...entry, grants: ["Funded by Dr Jane Doe"] }],
      }),
    ).toThrow();
  });

  it("reads gold set A2's draw and papers in a manifest, and one taken before gold set A2", () => {
    const drawn = {
      id: "s4",
      createdAt: "2026-11-11T12:00:00.000Z",
      goldA: { query: goldA.query, seed: goldA.seed, size: goldA.size },
      goldA2: { query: goldA2.query, seed: goldA2.seed, size: goldA2.size },
      papers: [
        {
          pmcid: "PMC1",
          set: "A2",
          sha256: "a".repeat(64),
          grants: ["C1234/A56789"],
        },
      ],
    };
    expect(manifest.parse(drawn)).toEqual(drawn);
    const before: Record<string, unknown> = { ...drawn };
    delete before.goldA2;
    expect(manifest.parse({ ...before, papers: [] })).toEqual({
      ...before,
      papers: [],
    });
  });

  it("reads gold set B2's papers in a manifest, with no grant ids", () => {
    const taken = {
      id: "s5",
      createdAt: "2026-11-12T12:00:00.000Z",
      goldA: { query: goldA.query, seed: goldA.seed, size: goldA.size },
      papers: [
        { pmcid: "PMC1", set: "B2", sha256: "a".repeat(64), grants: [] },
      ],
    };
    expect(manifest.parse(taken)).toEqual(taken);
  });

  // A snapshot taken before #128 joins an award group's sources with "; ".
  it("reads a paper file that joins an award group's sources in one string", () => {
    expect(
      paperFile.parse({
        pmcid: "PMC1",
        text: [],
        awards: [
          { source: "Cancer Research UK; Example Trust", ids: ["12345"] },
          { source: "", ids: ["1"] },
        ],
      }).awards,
    ).toEqual([
      { sources: ["Cancer Research UK", "Example Trust"], ids: ["12345"] },
      { sources: [], ids: ["1"] },
    ]);
  });

  it("reads a paper file that lists an award group's sources", () => {
    const awards = [{ sources: ["Cancer Research UK"], ids: ["A12345"] }];
    expect(paperFile.parse({ pmcid: "PMC1", text: [], awards }).awards).toEqual(
      awards,
    );
  });
});
