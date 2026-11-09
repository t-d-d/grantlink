import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pin } from "./pin.ts";

const manifest = JSON.stringify({
  id: "s1",
  createdAt: "2026-11-09T12:00:00.000Z",
  goldA: { query: "q", seed: 1, size: 2 },
  papers: [
    { pmcid: "PMC2", set: "A", sha256: "a".repeat(64), grants: ["A11111"] },
    { pmcid: "PMC1", set: "A", sha256: "b".repeat(64), grants: ["C1/A22222"] },
    { pmcid: "PMC3", set: "B", sha256: "c".repeat(64), grants: [] },
  ],
});
const snapshot = { about: "x", id: "s1", manifestSha256: null };
const goldA = { about: "y", query: "q", seed: 1, size: 2, papers: [] };

describe("pinning a snapshot", () => {
  it("pins the manifest's hash, and copies gold set A's ids and grant ids", () => {
    const result = pin(manifest, snapshot, goldA);
    expect(result.snapshot.manifestSha256).toBe(
      createHash("sha256").update(manifest).digest("hex"),
    );
    expect(result.goldA.papers).toEqual([
      { pmcid: "PMC1", grants: ["C1/A22222"] },
      { pmcid: "PMC2", grants: ["A11111"] },
    ]);
  });

  it("refuses a manifest for another snapshot", () => {
    expect(() => pin(manifest, { ...snapshot, id: "s2" }, goldA)).toThrow(
      /s2/u,
    );
  });

  it("refuses a manifest drawn with another query or seed", () => {
    expect(() => pin(manifest, snapshot, { ...goldA, seed: 2 })).toThrow();
  });
});
