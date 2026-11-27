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
function paperDeps(
  grants: string[],
  xml = "<funding-group><funding-statement>Funded by grant A56789.</funding-statement></funding-group>",
) {
  const calls: string[] = [];
  const stored = new Map<string, string>();
  const deps = {
    gold: { snapshotId: "s9" },
    europePmc: {
      fullText: (pmcid: string) => {
        calls.push(`fullText ${pmcid}`);
        return Promise.resolve(xml);
      },
      grants: (pmcid: string) => {
        calls.push(`grants ${pmcid}`);
        return Promise.resolve(grants);
      },
    },
    text: {
      putFundingText: () => Promise.resolve(),
      putSnapshotPaper: (_id: string, pmcid: string, body: string) => {
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

// Cancer Research UK's id in the Crossref Funder Registry, built from two
// parts so no file holds a twelve-digit number (test/infra.static.ts).
const FUNDER_ID = "501100" + "000289";

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

  // Gold set A's answers are the linked grants a paper prints (#502).
  it("passes over a gold set A paper whose full text prints none of its linked grants", async () => {
    const { deps, stored } = paperDeps(["A11111", "C2/A22222"]);
    expect(await snapshotPaper(deps, "PMC11", "A")).toEqual({ kept: false });
    expect(stored.size).toBe(0);
  });

  it("keeps only the linked grants a gold set A paper prints as its answers", async () => {
    const { deps } = paperDeps(["A11111", "C1234/A56789", "A22222"]);
    const taken = await snapshotPaper(deps, "PMC11", "A");
    expect(taken.kept && taken.entry.grants).toEqual(["C1234/A56789"]);
  });

  // Europe PMC often links one grant twice, in two forms (#508).
  it("records a grant Europe PMC links in two forms once, in its fuller form", async () => {
    const { deps } = paperDeps(
      ["56789", "C1234/A56789"],
      "<funding-group><funding-statement>Funded by C1234/A56789.</funding-statement></funding-group>",
    );
    const taken = await snapshotPaper(deps, "PMC11", "A");
    expect(taken.kept && taken.entry.grants).toEqual(["C1234/A56789"]);
  });

  it("keeps an award number with its A over the same number without", async () => {
    const { deps } = paperDeps(
      ["A11111", "56789", "A56789"],
      "<funding-group><funding-statement>Funded by A11111 and A56789.</funding-statement></funding-group>",
    );
    const taken = await snapshotPaper(deps, "PMC11", "A");
    expect(taken.kept && taken.entry.grants).toEqual(["A11111", "A56789"]);
  });

  // Europe PMC sometimes holds a trailing slash (#503), which is no part of
  // the grant, so it does not make a form the fuller one.
  it("keeps an award number with its A over one without and a trailing slash", async () => {
    const { deps } = paperDeps(
      ["56789/", "A56789"],
      "<funding-group><funding-statement>Funded by A56789.</funding-statement></funding-group>",
    );
    const taken = await snapshotPaper(deps, "PMC11", "A");
    expect(taken.kept && taken.entry.grants).toEqual(["A56789"]);
  });

  it("puts the fuller form in the place of the first, and leaves the others where they are", async () => {
    const { deps } = paperDeps(
      ["56789", "A11111", "C1234/A56789"],
      "<funding-group><funding-statement>Funded by A11111 and C1234/A56789.</funding-statement></funding-group>",
    );
    const taken = await snapshotPaper(deps, "PMC11", "A");
    expect(taken.kept && taken.entry.grants).toEqual([
      "C1234/A56789",
      "A11111",
    ]);
  });

  it("keeps a C/A pair over its award number with a CRUK prefix", async () => {
    const { deps } = paperDeps(
      ["CRUK-A56789", "C12/A56789"],
      "<funding-group><funding-statement>Funded by CRUK-A56789, C12/A56789.</funding-statement></funding-group>",
    );
    const taken = await snapshotPaper(deps, "PMC11", "A");
    expect(taken.kept && taken.entry.grants).toEqual(["C12/A56789"]);
  });

  it("judges printed against the whole article, not the funding sections it keeps", async () => {
    const { deps, stored } = paperDeps(
      ["A56789", "A11111"],
      "<article><funding-group><funding-statement>Funded by grant A56789.</funding-statement></funding-group><body><p>Supported by A11111.</p></body></article>",
    );
    const taken = await snapshotPaper(deps, "PMC11", "A");
    expect(taken.kept && taken.entry.grants).toEqual(["A56789", "A11111"]);
    expect(stored.get("PMC11")).not.toContain("A11111");
  });

  it("never takes Cancer Research UK's funder registry id as an answer, even where the paper prints it", async () => {
    const { deps } = paperDeps(
      [FUNDER_ID, "A56789"],
      `<funding-group><award-group><funding-source><institution-id>${FUNDER_ID}</institution-id></funding-source><award-id>A56789</award-id></award-group></funding-group>`,
    );
    const taken = await snapshotPaper(deps, "PMC11", "A");
    expect(taken.kept && taken.entry.grants).toEqual(["A56789"]);
  });

  it("never takes a linked id outside CRUK's reference forms, or a C part alone, as an answer", async () => {
    const { deps } = paperDeps(
      ["C5759", "204826/Z/16/Z", "Prominent", "A56789"],
      "<funding-group><funding-statement>Funded by C5759, A56789, 204826/Z/16/Z and Prominent.</funding-statement></funding-group>",
    );
    const taken = await snapshotPaper(deps, "PMC11", "A");
    expect(taken.kept && taken.entry.grants).toEqual(["A56789"]);
  });

  it("passes over a gold set A paper whose linked grants appear only in its reference list", async () => {
    const { deps } = paperDeps(
      ["A11111"],
      "<article><funding-group><funding-statement>Funded by CRUK.</funding-statement></funding-group><back><ref-list><ref>A11111</ref></ref-list></back></article>",
    );
    expect(await snapshotPaper(deps, "PMC11", "A")).toEqual({ kept: false });
  });

  it("passes over a gold set A paper linked only to the funder registry id, without reading its text", async () => {
    const { deps, calls } = paperDeps([FUNDER_ID]);
    expect(await snapshotPaper(deps, "PMC11", "A")).toEqual({ kept: false });
    expect(calls).toEqual(["grants PMC11"]);
  });

  it("writes the paper's file under the snapshot's own id", async () => {
    const written: string[] = [];
    const { deps } = paperDeps(["A56789"]);
    deps.gold = { ...deps.gold, snapshotId: "s3" };
    deps.text.putSnapshotPaper = (id, pmcid, body) => {
      written.push(`${id} ${pmcid}`);
      return Promise.resolve(body);
    };
    await snapshotPaper(deps, "PMC11", "A");
    expect(written).toEqual(["s3 PMC11"]);
  });

  it("passes over a gold set A paper whose article prints none of its grants, since its sample walks on", async () => {
    const { deps, stored } = paperDeps(["A56789"], "<article></article>");
    expect(await snapshotPaper(deps, "PMC11", "A")).toEqual({ kept: false });
    expect(stored.size).toBe(0);
  });

  // A cutter that drops a paper's funding text must show as a miss, not as
  // a smaller gold set, so the paper stays with its empty sections (#727).
  it.each(["A", "A2"] as const)(
    "keeps a gold set %s paper whose article prints a linked grant but whose cut is empty, as a miss (#727)",
    async (set) => {
      const { deps, stored } = paperDeps(
        ["A56789"],
        "<article><body><p>Supported by grant A56789.</p></body></article>",
      );
      const taken = await snapshotPaper(deps, "PMC11", set);
      expect(taken).toEqual({
        kept: true,
        entry: {
          pmcid: "PMC11",
          set,
          sha256: expect.any(String) as string,
          grants: ["A56789"],
        },
        empty: true,
      });
      expect(JSON.parse(stored.get("PMC11") ?? "null")).toEqual({
        pmcid: "PMC11",
        text: [],
        awards: [],
      });
    },
  );

  it("keeps a gold set B paper with no funding text or awards, with its empty sections (#399)", async () => {
    const { deps, stored } = paperDeps([], "<article></article>");
    const taken = await snapshotPaper(deps, "PMC11", "B");
    expect(taken).toEqual({
      kept: true,
      entry: {
        pmcid: "PMC11",
        set: "B",
        sha256: expect.any(String) as string,
        grants: [],
      },
      empty: true,
    });
    expect(JSON.parse(stored.get("PMC11") ?? "null")).toEqual({
      pmcid: "PMC11",
      text: [],
      awards: [],
    });
  });

  it("says a gold set B paper with funding text is not empty (#405)", async () => {
    const { deps } = paperDeps([]);
    const taken = await snapshotPaper(deps, "PMC11", "B");
    expect(taken).toMatchObject({ kept: true, empty: false });
  });
});
