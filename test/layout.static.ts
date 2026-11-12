import { describe, expect, it } from "vitest";
import { readRepoFile } from "./repo.ts";

// On a desktop screen the How it's run tables fit without scrolling
// sideways, while lines of prose stay the length they were (#735).
const css = readRepoFile("site/style.css").replace(/\/\*[\s\S]*?\*\//gu, "");

// Each style rule, with its selectors and its declarations as property to
// value. A rule inside @media or @supports is listed as if it were at the
// top level.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(
  ([, selectors = "", body = ""]) => {
    const found = new Map<string, string>();
    for (const line of body.split(";")) {
      const [property, ...value] = line.split(":");
      if (property === undefined || value.length === 0) continue;
      found.set(property.trim(), value.join(":").trim());
    }
    return { selectors: selectors.split(",").map((s) => s.trim()), found };
  },
);

// The declarations of each rule whose selector list names `selector`.
function declarations(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    for (const [property, value] of rule.found) found.set(property, value);
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
    const nowrap = rules
      .filter((rule) => rule.found.has("white-space"))
      .flatMap((rule) => rule.selectors)
      .filter((selector) => /(^|[\s>+~])th\b[^\s>+~]*$/u.test(selector));
    expect(nowrap).toEqual([]);
  });

  it("keeps a model id in a row header on one line", () => {
    expect(declarations("th code").get("white-space")).toBe("nowrap");
  });
});
