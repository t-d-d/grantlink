import { describe, expect, it } from "vitest";
import { CONTACT, CREDIT, NOTICE, TERMS, footerOf, textOf } from "./page.ts";
import { readRepoFile, repoFiles } from "./repo.ts";

// Cancer Research UK is named only to say whose grants grantlink reads, and
// every view carries the independence notice (PRD #1).
const views = repoFiles().filter(
  (path) => path.startsWith("site/") && path.endsWith(".html"),
);

describe("fitness: every view carries the independence notice (independence.md)", () => {
  it("finds the views", () => {
    expect(views).toContain("site/index.html");
  });

  it.each(views)(
    "%s carries the notice, the credit and the contact",
    (path) => {
      const html = readRepoFile(path);
      // The notice and the address belong in the footer (#593).
      const footer = footerOf(html);
      expect(footer).not.toBe("");
      expect(textOf(footer)).toMatch(NOTICE);
      expect(html).toMatch(CREDIT);
      expect(html).toMatch(TERMS);
      expect(footer).toContain(`href="mailto:${CONTACT}"`);
    },
  );

  it("carries the notice in the README", () => {
    expect(readRepoFile("README.md")).toMatch(
      /not affiliated with or endorsed by Cancer Research UK/u,
    );
  });
});

// On a phone a reader may see only the headline and the count, so the
// first screen says the page is independent too, as well as the footer
// (#588). Nothing may come between the headline and that line.
describe("the first screen says the page is independent (#588)", () => {
  it("puts the independence line straight after the headline", () => {
    const html = readRepoFile("site/index.html");
    const afterHeadline = /<\/h1>\s*(<p\b[^>]*>[\s\S]*?<\/p>)/u.exec(html);
    expect(afterHeadline).not.toBeNull();
    expect(textOf(afterHeadline?.[1] ?? "")).toMatch(NOTICE);
  });
});

describe("fitness: no CRUK logo or styling (independence.md)", () => {
  it("ships no image that names CRUK", () => {
    const named = repoFiles().filter((path) =>
      /cruk|cancer-?research/iu.test(path),
    );
    expect(named).toEqual([]);
  });
});
