import { createHash } from "node:crypto";
import { check } from "prettier";
import { describe, expect, it } from "vitest";
import { pin, toFile } from "./pin.ts";

const manifest = JSON.stringify({
  id: "s1",
  createdAt: "2026-11-09T12:00:00.000Z",
  goldA: { query: "q", seed: 1, size: 2 },
  goldA2: { query: "q", seed: 5, size: 2 },
  papers: [
    { pmcid: "PMC2", set: "A", sha256: "a".repeat(64), grants: ["A11111"] },
    { pmcid: "PMC1", set: "A", sha256: "b".repeat(64), grants: ["C1/A22222"] },
    { pmcid: "PMC3", set: "B", sha256: "c".repeat(64), grants: [] },
    { pmcid: "PMC5", set: "A2", sha256: "d".repeat(64), grants: ["A33333"] },
    { pmcid: "PMC4", set: "A2", sha256: "e".repeat(64), grants: ["A44444"] },
  ],
});
const snapshot = { about: "x", id: "s1", manifestSha256: null };
const goldA = { about: "y", query: "q", seed: 1, size: 2, papers: [] };
const goldA2 = { about: "z", query: "q", seed: 5, size: 2, papers: [] };

describe("pinning a snapshot", () => {
  it("pins the manifest's hash, and copies gold set A's ids and grant ids", () => {
    const result = pin(manifest, snapshot, goldA, goldA2);
    expect(result.snapshot.manifestSha256).toBe(
      createHash("sha256").update(manifest).digest("hex"),
    );
    expect(result.goldA.papers).toEqual([
      { pmcid: "PMC1", grants: ["C1/A22222"] },
      { pmcid: "PMC2", grants: ["A11111"] },
    ]);
  });

  it("refuses a manifest for another snapshot", () => {
    expect(() =>
      pin(manifest, { ...snapshot, id: "s2" }, goldA, goldA2),
    ).toThrow(/s2/u);
  });

  it("refuses a manifest drawn with another query or seed", () => {
    expect(() =>
      pin(manifest, snapshot, { ...goldA, seed: 2 }, goldA2),
    ).toThrow();
  });
});

describe("pinning gold set A2 (#706)", () => {
  it("copies gold set A2's ids and grant ids into its own file", () => {
    const result = pin(manifest, snapshot, goldA, goldA2);
    expect(result.goldA2).toEqual({
      ...goldA2,
      papers: [
        { pmcid: "PMC4", grants: ["A44444"] },
        { pmcid: "PMC5", grants: ["A33333"] },
      ],
    });
    expect(result.goldA.papers.map((paper) => paper.pmcid)).toEqual([
      "PMC1",
      "PMC2",
    ]);
  });

  it("refuses a manifest whose gold set A2 was drawn with another query, seed or size", () => {
    expect(() =>
      pin(manifest, snapshot, goldA, { ...goldA2, seed: 6 }),
    ).toThrow(/gold set A2/u);
    expect(() =>
      pin(manifest, snapshot, goldA, { ...goldA2, size: 3 }),
    ).toThrow(/gold set A2/u);
  });

  it("refuses a manifest with no gold set A2 draw", () => {
    const rest = JSON.parse(manifest) as Record<string, unknown>;
    delete rest.goldA2;
    expect(() => pin(JSON.stringify(rest), snapshot, goldA, goldA2)).toThrow(
      /gold set A2/u,
    );
  });
});

describe("writing a pinned file", () => {
  it("writes JSON the gate's format check accepts", async () => {
    const { goldA: pinned } = pin(manifest, snapshot, goldA, goldA2);
    const text = await toFile("gold-a.json", pinned);
    await expect(check(text, { filepath: "gold-a.json" })).resolves.toBe(true);
    expect(JSON.parse(text)).toEqual(pinned);
  });
});
