import { describe, expect, it } from "vitest";
import {
  FUNDING_FOOTNOTE_TYPES,
  FUNDING_METADATA,
  FUNDING_SECTION_TYPE,
  isFundingSectionAt,
} from "../src/europepmc/jats.ts";
import { strayParts } from "./fixture-parts.ts";
import { FIXTURES, RECORDED, fixture, sources } from "./fixtures.ts";
import { readRepoFile, repoFiles } from "./repo.ts";

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
    // Every section, nested ones too, is one the cutter reads as funding
    // (#159).
    for (const section of text.matchAll(/<sec\b[^>]*>/gu)) {
      expect(isFundingSectionAt(text, section.index), section[0]).toBe(true);
    }
  });

  // Nor may it keep the author list, the affiliations, the title, the
  // reference list or any text outside its ids, licence, funding metadata,
  // acknowledgements and funding sections, where real names would be (#140). The names test cannot see these: it checks the
  // replacement names are there, not that no others are.
  it.each(RECORDED)(
    "$file, recorded from a paper, keeps nothing outside its ids, licence and funding sections",
    (entry) => {
      expect(strayParts(fixture(entry.file))).toEqual([]);
    },
  );

  // The check reads a funding group by the names the cutter reads it by, so
  // when the cutter reads another element the check follows. Each name is
  // written once, in the cutter, and never in the check, and the cutter
  // reads by each, so the check allows no element the cutter has stopped
  // reading (#305).
  const cutter = readRepoFile("src/europepmc/jats.ts");
  const check = readRepoFile("test/fixture-parts.ts");
  it.each(Object.entries(FUNDING_METADATA))(
    "%s (%s) is written once in the cutter, read by it, and not in the check",
    (key, name) => {
      expect(cutter.split(name)).toHaveLength(2);
      expect(cutter).toContain(`FUNDING_METADATA.${key}`);
      expect(check).not.toContain(name);
    },
  );

  // The check expects the sec-type and fn-type values the cutter matches a
  // funding part by, so when the cutter reads another type the check
  // follows. The cutter reads each attribute in one place, matches it
  // there through the values it exports, and the check copies none of them
  // (#417).
  it.each(["sec-type", "fn-type"])(
    "the cutter reads %s in one place",
    (name) => {
      expect(cutter.split(`"${name}"`)).toHaveLength(2);
    },
  );
  it("the cutter matches sec-type by the pattern it exports, and the check does not copy it", () => {
    expect(cutter).toContain("FUNDING_SECTION_TYPE.test(");
    expect(check).toContain("FUNDING_SECTION_TYPE");
    expect(check).not.toContain(FUNDING_SECTION_TYPE.source);
  });
  it("the cutter matches fn-type through the list it exports", () => {
    expect(cutter).toContain("FUNDING_FOOTNOTE_TYPES.includes(");
    expect(check).toContain("FUNDING_FOOTNOTE_TYPES");
  });
  it.each(FUNDING_FOOTNOTE_TYPES)(
    "the check does not copy fn-type %s",
    (type) => {
      expect(check).not.toContain(`"${type}"`);
    },
  );

  // The licence a recorded paper carries, in its own licence element, is
  // the one its entry lists.
  it.each(RECORDED)("$file carries the licence it is listed under", (entry) => {
    const version = /^CC-BY-(\d\.\d)$/u.exec(entry.licence)?.[1];
    const url =
      version === undefined
        ? "creativecommons.org/publicdomain/zero/1.0/"
        : `creativecommons.org/licenses/by/${version}/`;
    const licence = /<license\b[^>]*>([\s\S]*?)<\/license>/u.exec(
      fixture(entry.file),
    )?.[1];
    expect(licence).toBeDefined();
    expect(licence).toContain(url);
  });

  it("says how each fixture came to be", () => {
    for (const entry of sources.fixtures) {
      expect(entry.origin).toMatch(/^(?:recorded from |written by hand)/u);
    }
  });
});

// #49: the integration tier reads Europe PMC's real replies, not only ones
// written in their shape.
describe("full texts recorded for the integration tier", () => {
  it("holds at least three full texts recorded from papers", () => {
    expect(RECORDED.length).toBeGreaterThanOrEqual(3);
  });

  it.each(RECORDED)(
    "$file names the Europe PMC full text it was recorded from",
    (entry) => {
      expect(entry.origin).toBe(
        `recorded from https://www.ebi.ac.uk/europepmc/webservices/rest/${entry.pmcid}/fullTextXML`,
      );
    },
  );
});
