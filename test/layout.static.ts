import { describe, expect, it } from "vitest";
import { readRepoFile } from "./repo.ts";

// On a desktop screen the How it's run tables fit without scrolling
// sideways, while lines of prose stay the length they were (#735).
const css = readRepoFile("site/style.css").replace(/\/\*[\s\S]*?\*\//gu, "");

// The declarations of each top-level rule whose selector list names
// `selector`, as property to value.
function declarations(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, selectors = "", body = ""] of css.matchAll(
    /([^{}]+)\{([^{}]*)\}/gu,
  )) {
    if (!selectors.split(",").some((s) => s.trim() === selector)) continue;
    for (const line of body.split(";")) {
      const [property, ...value] = line.split(":");
      if (property === undefined || value.length === 0) continue;
      found.set(property.trim(), value.join(":").trim());
    }
  }
  return found;
}

describe("the page's width (#735)", () => {
  it("lets the page grow to 56rem on a wide screen", () => {
    expect(declarations("body").get("max-width")).toBe("56rem");
  });

  it("keeps paragraphs at most 42rem wide, as wide as before", () => {
    expect(declarations("p").get("max-width")).toBe("42rem");
  });

  it("lets table headers wrap", () => {
    expect(declarations("th").get("white-space")).toBeUndefined();
  });
});
