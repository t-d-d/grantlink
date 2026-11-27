import { describe, expect, it } from "vitest";
import { pinned } from "../../evals/gold.ts";
import { latest } from "../extract/versions.ts";
import { CUTTER_VERSION, CUTTER_VERSIONS } from "./jats.ts";

// A snapshot holds the cut its cutter made, so a change to what the cutter
// keeps names a new snapshot, which starts unpinned (#420).
describe("fitness: a cutter change names a new snapshot (evals.md)", () => {
  it("names in evals/snapshot.json the cutter version the code cuts with", () => {
    expect(CUTTER_VERSION).toMatch(/^cutter-\d+$/u);
    expect(pinned.cutter).toBe(CUTTER_VERSION);
  });
});

// Each bump adds its own line naming its issue, so two bumps at once
// conflict in git rather than merge (#414).
describe("the cutter's version", () => {
  it("is read from the last line of the cutter's history, not set by hand", () => {
    expect(CUTTER_VERSION).toBe(latest("cutter", CUTTER_VERSIONS));
  });
});
