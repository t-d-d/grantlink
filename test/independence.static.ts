import { describe, expect, it } from "vitest";
import { CONTACT, CREDIT, NOTICE, TERMS, textOf } from "./page.ts";
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
      expect(textOf(html)).toMatch(NOTICE);
      expect(html).toMatch(CREDIT);
      expect(html).toMatch(TERMS);
      expect(html).toContain(`mailto:${CONTACT}`);
    },
  );

  it("carries the notice in the README", () => {
    expect(readRepoFile("README.md")).toMatch(
      /not affiliated with or endorsed by Cancer Research UK/u,
    );
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
