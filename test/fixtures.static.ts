import { describe, expect, it } from "vitest";
import { FIXTURES, fixture, sources } from "./fixtures.ts";
import { repoFiles } from "./repo.ts";

// Europe PMC's responses in the repo, which the repo being public makes
// public too (#10).
const files = repoFiles()
  .filter((path) => path.startsWith(`${FIXTURES}/`))
  .map((path) => path.slice(FIXTURES.length + 1))
  .filter((file) => file !== "sources.json");

describe("fitness: no real text in the repo (personal-data.md)", () => {
  it("finds the fixtures", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("lists every fixture in its sources file, and lists nothing else", () => {
    expect(sources.fixtures.map((entry) => entry.file).sort()).toEqual(
      [...files].sort(),
    );
  });

  it.each(sources.fixtures)("$file is under CC BY or CC0", (entry) => {
    expect(entry.licence).toMatch(/^(?:CC0-1\.0|CC-BY-\d\.\d)$/u);
  });

  it.each(sources.fixtures)(
    "$file carries only the replacement names it lists",
    (entry) => {
      for (const name of entry.names) {
        expect(fixture(entry.file)).toContain(name);
      }
    },
  );

  // A hand-written fixture may carry an abstract and a body, made up, to
  // test that the cutter drops them. One recorded from a paper may not.
  it.each(
    sources.fixtures.filter((entry) => entry.origin.startsWith("recorded")),
  )("$file, recorded from a paper, is cut to its funding sections", (entry) => {
    const text = fixture(entry.file);
    expect(text).not.toMatch(/<abstract\b/u);
    for (const [, open = ""] of text.matchAll(/<sec\b([^>]*)>/gu)) {
      expect(open).toContain('sec-type="funding"');
    }
  });

  it("says how each fixture came to be", () => {
    for (const entry of sources.fixtures) {
      expect(entry.origin).toMatch(/^(?:recorded from |written by hand)/u);
    }
  });
});
