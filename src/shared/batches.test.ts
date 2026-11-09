import { describe, expect, it } from "vitest";
import { batches } from "./batches.ts";

describe("batches", () => {
  it("splits a list into batches of a size, the last one short", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("gives no batch for an empty list", () => {
    expect(batches([], 25)).toEqual([]);
  });

  it("refuses a size below one", () => {
    expect(() => batches([1], 0)).toThrow();
  });
});
