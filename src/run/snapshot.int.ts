import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { snapshotKeys } from "../../evals/gold.ts";
import { FAKE_GOLD, fakeDeps, isGoldSearch, reply } from "../../test/fakes.ts";
import { EuropePmcError } from "../europepmc/client.ts";
import { makeRun, type RunSummary } from "./run.ts";

// The snapshot with a gold set B of its own, passed in through the run's
// deps, so these tests never read the repo's labels. Its three papers are
// recorded fixtures the run reads first in its own search, as a labelled
// paper may be, and none is in gold set A's sample.

const LABELLED = ["PMC13628515", "PMC13642255", "PMC13664392"];

// Each paper labelled with no references, unless `references` gives it
// some.
const goldB = (
  pmcids: string[],
  references: Record<string, string[]> = {},
) => ({
  about: "a test's own gold set B",
  papers: pmcids.map((pmcid) => ({
    pmcid,
    references: references[pmcid] ?? [],
  })),
});

const labelledDeps = () => fakeDeps({ gold: { goldB: goldB(LABELLED) } });

const manifestKey = (fake: ReturnType<typeof fakeDeps>) =>
  snapshotKeys.manifest(fake.deps.gold.snapshotId);

beforeAll(() =>
  LocalDurableTestRunner.setupTestEnvironment({ skipTime: true }),
);
afterAll(() => LocalDurableTestRunner.teardownTestEnvironment());

// Every line logged, kept out of the test's output.
const logs: string[] = [];
const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
  logs.push(args.map(String).join(" "));
});
afterEach(() => {
  logs.length = 0;
});
afterAll(() => {
  spy.mockRestore();
});

// The log lines with event `event`, each parsed.
function logged(event: string): Record<string, unknown>[] {
  return logs
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === event);
}

async function runWith(fake: ReturnType<typeof fakeDeps>) {
  const runner = new LocalDurableTestRunner<RunSummary>({
    handlerFunction: withDurableExecution(makeRun(fake.deps)),
  });
  const execution = await runner.run({ payload: {} });
  const status = execution.getStatus();
  return {
    status,
    // The local runner's clock when the run ended.
    ended: Date.now(),
    result: status === "SUCCEEDED" ? execution.getResult() : undefined,
  };
}

// Europe PMC answering the first labelled paper's full text with `first`
// once the snapshot starts, and recording every gold set B paper the
// snapshot asks about. The run reads the same papers first, as it finds
// them in its own search.
function failingFirstLabelled(
  first: () => Promise<string>,
  fake = labelledDeps(),
) {
  const real = fake.deps.europePmc;
  let snapshot = false;
  const hasSnapshot = fake.deps.text.hasSnapshot.bind(fake.deps.text);
  fake.deps.text.hasSnapshot = (id) => {
    snapshot = true;
    return hasSnapshot(id);
  };
  const asked: string[] = [];
  fake.deps.europePmc = {
    search: real.search.bind(real),
    grants: real.grants.bind(real),
    sent: real.sent.bind(real),
    fullText: (pmcid) => {
      if (!snapshot) return real.fullText(pmcid);
      if (LABELLED.includes(pmcid)) asked.push(pmcid);
      if (pmcid === LABELLED[0]) return first();
      return real.fullText(pmcid);
    },
  };
  return { fake, asked };
}

describe("gold set B in the eval snapshot (evals.md)", () => {
  it("keeps every labelled paper when each can be read", async () => {
    const fake = labelledDeps();
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toMatchObject({
      taken: true,
      papers: 2 + LABELLED.length,
    });
    expect(fake.text.has(manifestKey(fake))).toBe(true);
  });

  it("leaves the snapshot for the next run when a labelled paper cannot be read", async () => {
    // PMC0000009 has no fixture, so the fake Europe PMC answers 503.
    const fake = fakeDeps({
      gold: { goldB: goldB([...LABELLED.slice(0, 1), "PMC0000009"]) },
    });
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.published).toMatchObject({ published: true });
    expect(result?.snapshot).toEqual({
      taken: false,
      reason: "a gold set B paper could not be read",
    });
    expect(fake.text.has(manifestKey(fake))).toBe(false);
    expect(logged("snapshot-b-empty")).toEqual([]);
  });

  it.each([
    new EuropePmcError(
      "Europe PMC answered 429, asked to wait 7200s",
      429,
      7200,
    ),
    new EuropePmcError("Europe PMC answered 404", 404),
  ])(
    "asks Europe PMC nothing more once one labelled paper fails ($message)",
    async (error) => {
      const { fake, asked } = failingFirstLabelled(() => Promise.reject(error));
      const { status, result } = await runWith(fake);
      expect(status).toBe("SUCCEEDED");
      expect(result?.snapshot).toEqual({
        taken: false,
        reason: "a gold set B paper could not be read",
      });
      expect(asked).toEqual([LABELLED[0]]);
      expect(fake.text.has(manifestKey(fake))).toBe(false);
    },
  );

  it("ends only once a labelled paper's refusal has been waited out", async () => {
    let notBefore = 0;
    const { fake } = failingFirstLabelled(() => {
      notBefore = Date.now() + 7_200_000;
      return Promise.reject(
        new EuropePmcError(
          "Europe PMC answered 429, asked to wait 7200s",
          429,
          7200,
        ),
      );
    });
    const { status, ended } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(notBefore).toBeGreaterThan(0);
    expect(ended).toBeGreaterThanOrEqual(notBefore);
  });

  it("keeps a labelled paper with no funding text or awards, and goes on to the rest (#399)", async () => {
    const { fake, asked } = failingFirstLabelled(() =>
      Promise.resolve("<article></article>"),
    );
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toMatchObject({
      taken: true,
      papers: 2 + LABELLED.length,
    });
    expect(asked).toEqual(LABELLED);
    const manifest = JSON.parse(String(fake.text.get(manifestKey(fake)))) as {
      papers: { pmcid: string; set: string }[];
    };
    expect(manifest.papers).toContainEqual(
      expect.objectContaining({ pmcid: LABELLED[0], set: "B" }),
    );
    expect(
      JSON.parse(
        String(
          fake.text.get(
            snapshotKeys.paper(fake.deps.gold.snapshotId, LABELLED[0] ?? ""),
          ),
        ),
      ),
    ).toEqual({ pmcid: LABELLED[0], text: [], awards: [] });
  });

  it("keeps a labelled paper with empty sections whose label lists references, and logs once how many there were (#405)", async () => {
    // The second labelled paper lists references too, but its sections
    // are not empty, so it is not counted.
    const { fake } = failingFirstLabelled(
      () => Promise.resolve("<article></article>"),
      fakeDeps({
        gold: {
          goldB: goldB(LABELLED, {
            [LABELLED[0] ?? ""]: ["A56789"],
            [LABELLED[1] ?? ""]: ["A56789"],
          }),
        },
      }),
    );
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toMatchObject({
      taken: true,
      papers: 2 + LABELLED.length,
    });
    const manifest = JSON.parse(String(fake.text.get(manifestKey(fake)))) as {
      papers: { pmcid: string; set: string }[];
    };
    expect(manifest.papers).toContainEqual(
      expect.objectContaining({ pmcid: LABELLED[0], set: "B" }),
    );
    expect(logged("snapshot-b-empty")).toEqual([
      {
        level: "info",
        event: "snapshot-b-empty",
        runId: result?.runId,
        snapshotId: fake.deps.gold.snapshotId,
        count: 1,
        pmcids: LABELLED[0],
      },
    ]);
  });

  it("does not count a labelled paper with empty sections whose label lists no references (#405)", async () => {
    const { fake } = failingFirstLabelled(() =>
      Promise.resolve("<article></article>"),
    );
    const { result } = await runWith(fake);
    expect(result?.snapshot).toMatchObject({ taken: true });
    expect(logged("snapshot-b-empty")).toEqual([
      expect.objectContaining({ count: 0, pmcids: "" }),
    ]);
  });
});

describe("fitness: no paper in gold set A2 is in gold set A (evals.md)", () => {
  // Gold set A's search finds PMC0000001 and PMC0000002, each linked to a
  // grant it prints, and PMC0000003, linked to none.
  const manifestOf = (fake: ReturnType<typeof fakeDeps>) =>
    JSON.parse(String(fake.text.get(manifestKey(fake)))) as {
      goldA2?: { query: string; seed: number; size: number };
      papers: { pmcid: string; set: string; grants: string[] }[];
    };
  const inSet = (fake: ReturnType<typeof fakeDeps>, set: string) =>
    manifestOf(fake)
      .papers.filter((paper) => paper.set === set)
      .map((paper) => paper.pmcid)
      .sort();

  it("passes over a candidate the snapshot takes for gold set A, drawing from the same search", async () => {
    const fake = fakeDeps({
      gold: { goldA: { ...FAKE_GOLD.goldA, size: 1 } },
    });
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toMatchObject({ taken: true });
    const a = inSet(fake, "A");
    const a2 = inSet(fake, "A2");
    expect(a).toHaveLength(1);
    expect(a2).toHaveLength(1);
    expect([...a, ...a2].sort()).toEqual(["PMC0000001", "PMC0000002"]);
    // Gold set A2 has gold set A's query, so one search serves both.
    expect(fake.requests.filter(isGoldSearch)).toHaveLength(1);
    const { goldA2 } = FAKE_GOLD;
    expect(manifestOf(fake).goldA2).toEqual({
      query: goldA2.query,
      seed: goldA2.seed,
      size: goldA2.size,
    });
    const kept = manifestOf(fake).papers.find((p) => p.set === "A2");
    expect(kept?.grants.length).toBeGreaterThan(0);
  });

  it("passes over a candidate in gold set A as the repo pinned it", async () => {
    const fake = fakeDeps({
      gold: {
        goldA: {
          ...FAKE_GOLD.goldA,
          papers: [{ pmcid: "PMC0000001", grants: ["A56789"] }],
        },
      },
    });
    const { status } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(inSet(fake, "A")).toEqual(["PMC0000001"]);
    expect(inSet(fake, "A2")).toEqual(["PMC0000002"]);
    // Gold set A's papers are pinned, so gold set A2 searches for its own.
    expect(fake.requests.filter(isGoldSearch)).toHaveLength(1);
  });

  it("passes over a pinned gold set A2 paper that is in gold set A", async () => {
    const fake = fakeDeps({
      gold: {
        goldA: {
          ...FAKE_GOLD.goldA,
          papers: [{ pmcid: "PMC0000001", grants: ["A56789"] }],
        },
        goldA2: {
          ...FAKE_GOLD.goldA2,
          papers: [
            { pmcid: "PMC0000001", grants: ["A56789"] },
            { pmcid: "PMC0000002", grants: ["RRCOER-Jun24\\100008"] },
          ],
        },
      },
    });
    const { status } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(inSet(fake, "A")).toEqual(["PMC0000001"]);
    expect(inSet(fake, "A2")).toEqual(["PMC0000002"]);
    expect(fake.requests.some(isGoldSearch)).toBe(false);
  });

  it("searches for gold set A2 before it reads gold set A, so a refused search costs no paper", async () => {
    const fake = fakeDeps({
      gold: {
        goldA: {
          ...FAKE_GOLD.goldA,
          papers: [{ pmcid: "PMC0000001", grants: ["A56789"] }],
        },
      },
      goldSearch: () => reply("", 429, { "Retry-After": "300" }),
    });
    // The run reads PMC0000001 in its own search, so only what Europe PMC
    // is asked once the snapshot starts counts.
    let from = Infinity;
    const hasSnapshot = fake.deps.text.hasSnapshot.bind(fake.deps.text);
    fake.deps.text.hasSnapshot = (id) => {
      from = Math.min(from, fake.requests.length);
      return hasSnapshot(id);
    };
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toEqual({
      taken: false,
      reason: "Europe PMC refused gold set A2's search",
    });
    expect(logged("snapshot-search-ended")).toEqual([
      expect.objectContaining({ set: "A2", refused: true }),
    ]);
    // The snapshot asked about no paper, only for gold set A2's search.
    const asked = fake.requests.slice(from);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(isGoldSearch)).toBe(true);
  });
});
