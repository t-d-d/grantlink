import { describe, expect, it } from "vitest";

describe("fitness: the gate is offline (code-and-tests.md)", () => {
  it("refuses a request past loopback", async () => {
    await expect(fetch("https://www.ebi.ac.uk/")).rejects.toThrow();
  });

  it("refuses a DNS lookup of an outside name", async () => {
    const { lookup } = await import("node:dns/promises");
    expect(() => lookup("openrouter.ai")).toThrow("The gate is offline");
  });
});
