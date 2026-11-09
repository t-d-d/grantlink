import { describe, expect, it } from "vitest";
import {
  goldA,
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
