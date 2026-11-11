import { describe, expect, it } from "vitest";
import {
  LARGEST_PAGE_SIZE,
  type EuropePmc,
  type SearchPage,
} from "../../src/europepmc/client.ts";
import { draw, heldOut, SHEET_COLUMNS, sheetCsv, upTo } from "./draw.ts";

const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `PMC${String(from + i)}`);

// A fake Europe PMC that answers one query, a page at a time, and reads no
// paper's text: the draw never needs it.
function fake(query: string, pages: string[][]) {
  const searched: {
    selection: string | undefined;
    size: number | undefined;
  }[] = [];
  let read = 0;
  const api: EuropePmc = {
    sent: () => searched.length + read,
    search(cursor, selection, pageSize): Promise<SearchPage> {
      searched.push({ selection, size: pageSize });
      if (selection !== query)
        throw new Error(`unexpected query ${String(selection)}`);
      const at = cursor === "*" ? 0 : Number(cursor);
      const papers = pages[at] ?? [];
      return Promise.resolve({
        hitCount: pages.flat().length,
        nextCursor: at + 1 < pages.length ? String(at + 1) : null,
        skipped: 0,
        papers: papers.map((pmcid) => ({ pmcid, title: "" })),
      });
    },
    fullText() {
      read += 1;
      return Promise.reject(new Error("the draw reads no paper's text"));
    },
    grants: () => Promise.resolve([]),
  };
  return { api, searched, read: () => read };
}

describe("drawing gold set C", () => {
  const population = ids(1, 300);
  const goldB = ids(1, 150).filter((_, i) => i % 3 === 0);

  it("gives the same papers with the recorded seed over the same papers", () => {
    const first = heldOut(population, goldB, 20261111, 100);
    const again = heldOut([...population].reverse(), goldB, 20261111, 100);
    expect(again).toEqual(first);
    expect(first).toHaveLength(100);
    expect(new Set(first).size).toBe(100);
    expect(heldOut(population, goldB, 20261112, 100)).not.toEqual(first);
  });

  it("leaves out every gold set B paper", () => {
    const drawn = heldOut(population, goldB, 20261111, 250);
    expect(drawn.filter((pmcid) => goldB.includes(pmcid))).toEqual([]);
    expect(drawn).toHaveLength(250);
  });

  it("refuses to draw more papers than are left", () => {
    expect(() => heldOut(ids(1, 10), ids(1, 5), 1, 6)).toThrow(/5/u);
  });

  it("reads every page of the search at the largest page size, and no text", async () => {
    const query = "Q";
    const { api, searched, read } = fake(query, [
      ids(1, 4),
      ids(5, 8),
      ids(9, 12),
    ]);
    const result = await draw(api, {
      query,
      seed: 3,
      size: 5,
      exclude: ["PMC2"],
    });
    expect(result.population).toBe(12);
    expect(result.papers).toEqual(heldOut(ids(1, 12), ["PMC2"], 3, 5));
    expect(searched).toHaveLength(3);
    expect(new Set(searched.map((s) => s.size))).toEqual(
      new Set([LARGEST_PAGE_SIZE]),
    );
    expect(read()).toBe(0);
  });

  it("counts a paper the search returns twice once", async () => {
    const { api } = fake("Q", [ids(1, 4), ids(3, 6)]);
    const result = await draw(api, {
      query: "Q",
      seed: 3,
      size: 2,
      exclude: [],
    });
    expect(result.population).toBe(6);
  });
});

describe("the dated query", () => {
  it("keeps the live search and stops at the day of the draw", () => {
    expect(upTo("A AND B", "2026-11-11")).toBe(
      "(A AND B) AND FIRST_PDATE:[1900-01-01 TO 2026-11-11]",
    );
  });
});

describe("gold set C's labelling sheet", () => {
  it("has the guide's columns, and a row per paper with only its id and link", () => {
    expect(SHEET_COLUMNS).toEqual([
      "pmcid",
      "europe_pmc",
      "funded",
      "references_as_written",
      "references_normalised",
      "note",
      "passes",
      "look_in",
      "checked",
    ]);
    expect(sheetCsv(["PMC7"]).split("\n")).toEqual([
      SHEET_COLUMNS.join(","),
      "PMC7,https://europepmc.org/article/PMC/PMC7,,,,,,,",
      "",
    ]);
  });
});
