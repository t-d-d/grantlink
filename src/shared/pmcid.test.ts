import { describe, expect, it } from "vitest";
import { isPmcid, pmcid } from "./pmcid.ts";

describe("the PMCID pattern", () => {
  it.each(["PMC1", "PMC11234567"])("takes %s", (id) => {
    expect(isPmcid(id)).toBe(true);
    expect(pmcid.parse(id)).toBe(id);
  });

  it.each(["", "PMC", "pmc11", "PMC11a", " PMC11", "PMC11\n", "12345"])(
    "refuses %j",
    (id) => {
      expect(isPmcid(id)).toBe(false);
      expect(() => pmcid.parse(id)).toThrow();
    },
  );
});
