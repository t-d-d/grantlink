import { describe, expect, it } from "vitest";
import { fakeDeps, isGoldSearch } from "../../test/fakes.ts";
import { searchGoldA, sample, snapshotPaper } from "./snapshot.ts";
import type { Deps } from "./steps.ts";

const ids = Array.from({ length: 50 }, (_, i) => `PMC${String(i + 1)}`);

describe("sampling gold set A", () => {
  it("gives the same order for the same papers and seed, whatever order they came in", () => {
    const shuffled = [...ids].reverse();
    expect(sample(shuffled, 7)).toEqual(sample(ids, 7));
  });

  it("gives another order for another seed", () => {
    expect(sample(ids, 8)).not.toEqual(sample(ids, 7));
  });

  it("keeps every paper once", () => {
    const order = sample([...ids, "PMC3"], 7);
    expect(order).toHaveLength(50);
    expect(new Set(order)).toEqual(new Set(ids));
  });

  it("is not the order it was given", () => {
    expect(sample(ids, 7)).not.toEqual(ids);
  });
});

// A paper with made-up funding text, and the grant ids Europe PMC links it
// to. Only the calls snapshotPaper makes are answered.
function paperDeps(grants: string[]) {
  const calls: string[] = [];
  const stored = new Map<string, string>();
  const deps = {
    europePmc: {
      fullText: (pmcid: string) => {
        calls.push(`fullText ${pmcid}`);
        return Promise.resolve(
          "<funding-group><funding-statement>Funded by grant A56789.</funding-statement></funding-group>",
        );
      },
      grants: (pmcid: string) => {
        calls.push(`grants ${pmcid}`);
        return Promise.resolve(grants);
      },
    },
    text: {
      putFundingText: () => Promise.resolve(),
      putSnapshotPaper: (pmcid: string, body: string) => {
        stored.set(pmcid, body);
        return Promise.resolve(body);
      },
    },
  } as unknown as Deps;
  return { deps, calls, stored };
}

describe("searching for gold set A", () => {
  // Its step keeps only the PMCIDs, so a page as large as Europe PMC gives
  // fits in a checkpoint, and the search asks Europe PMC fewer times.
  it("asks for pages as large as Europe PMC gives", async () => {
    const fake = fakeDeps();
    await searchGoldA(fake.deps, "*");
    const search = fake.requests.find((url) => isGoldSearch(url));
    expect(search?.searchParams.get("pageSize")).toBe("1000");
  });
});

describe("taking one gold paper", () => {
  it("passes over a gold set A paper Europe PMC links to no grant, without reading its text", async () => {
    const { deps, calls, stored } = paperDeps([]);
    expect(await snapshotPaper(deps, "PMC11", "A")).toEqual({ kept: false });
    expect(calls).toEqual(["grants PMC11"]);
    expect(stored.size).toBe(0);
  });

  it("keeps only the grant ids the manifest can hold, so one odd id cannot stop the snapshot", async () => {
    const { deps } = paperDeps([
      "A56789",
      "Programme grant 2021",
      "x".repeat(41),
    ]);
    const taken = await snapshotPaper(deps, "PMC11", "A");
    expect(taken.kept && taken.entry.grants).toEqual(["A56789"]);
  });

  it("passes over a gold set A paper whose grant ids the manifest cannot hold", async () => {
    const { deps } = paperDeps(["Programme grant 2021"]);
    expect(await snapshotPaper(deps, "PMC11", "A")).toEqual({ kept: false });
  });
});
