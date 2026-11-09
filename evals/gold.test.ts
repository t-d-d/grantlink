import { describe, expect, it } from "vitest";
import { goldA, goldB, manifest, pinned } from "./gold.ts";

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

  it("holds labels for gold set B, or none yet", () => {
    expect(Array.isArray(goldB.papers)).toBe(true);
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
});
