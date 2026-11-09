import { describe, expect, it } from "vitest";
import { sample } from "./snapshot.ts";

const ids = Array.from({ length: 50 }, (_, i) => `PMC${String(i + 1)}`);

describe("sampling gold set A", () => {
  it("gives the same order for the same papers and seed, whatever order they came in", () => {
    const shuffled = [...ids].reverse();
    expect(sample(shuffled, 7)).toEqual(sample(ids, 7));
  });

  it("gives another order for another seed", () => {
    expect(sample(ids, 8)).not.toEqual(sample(ids, 7));
  });

  it("keeps every paper once", () => {
    const order = sample([...ids, "PMC3"], 7);
    expect(order).toHaveLength(50);
    expect(new Set(order)).toEqual(new Set(ids));
  });

  it("is not the order it was given", () => {
    expect(sample(ids, 7)).not.toEqual(ids);
  });
});
