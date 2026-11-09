import { createHash } from "node:crypto";
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
import {
  fakeDeps,
  fakeRelease,
  isGoldSearch,
  reply,
} from "../../test/fakes.ts";
import { NAMES, RECORDED } from "../../test/fixtures.ts";
import { EuropePmcError } from "../europepmc/client.ts";
import { found } from "../page/found.ts";
import { makeRun, type RunSummary } from "./run.ts";

// A whole run under the SDK's local runner, which replays the body as
// Lambda does, against Europe PMC's responses from the fixtures and stores
// held in memory.

beforeAll(() =>
  LocalDurableTestRunner.setupTestEnvironment({ skipTime: true }),
);
afterAll(() => LocalDurableTestRunner.teardownTestEnvironment());

const logs: string[] = [];
const spy = vi
  .spyOn(console, "log")
  .mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
afterEach(() => {
  logs.length = 0;
});
afterAll(() => {
  spy.mockRestore();
});

async function runWith(fake: ReturnType<typeof fakeDeps>) {
  const runner = new LocalDurableTestRunner<RunSummary>({
    handlerFunction: withDurableExecution(makeRun(fake.deps)),
  });
  const execution = await runner.run({ payload: {} });
  const status = execution.getStatus();
  return {
    status,
    result: status === "SUCCEEDED" ? execution.getResult() : undefined,
    // Why the run failed, if it did.
    error: status === "FAILED" ? execution.getError().errorMessage : undefined,
    // How long each named step waited before its next attempt, in seconds.
    retryDelays: (step: string) =>
      execution
        .getHistoryEvents()
        .filter((event) => event.Name === step)
        .flatMap(
          (event) =>
            event.StepFailedDetails?.RetryDetails?.NextAttemptDelaySeconds ??
            [],
        ),
  };
}

// A search page whose every PMCID is malformed, as if Europe PMC had
// changed how it writes them.
const malformedPage = () =>
  reply(
    JSON.stringify({
      hitCount: 2,
      resultList: {
        result: [{ pmcid: "PMC 1" }, { pmcid: "pmc2" }],
      },
    }),
  );

// A search of two pages: the first holds `pmcids`, and the last holds one
// result alone, whose PMCID is malformed.
const smallLastPageMalformed = (pmcids: string[]) => (cursor: string) =>
  reply(
    JSON.stringify(
      cursor === "*"
        ? {
            hitCount: pmcids.length + 1,
            nextCursorMark: "AoE",
            resultList: { result: pmcids.map((pmcid) => ({ pmcid })) },
          }
        : {
            hitCount: pmcids.length + 1,
            nextCursorMark: "AoE",
            resultList: { result: [{ pmcid: "PMC 9" }] },
          },
    ),
  );

// A paper step whose full text Europe PMC refuses every time with `error`.
function refusingPapers(error: Error) {
  const fake = fakeDeps();
  fake.deps.europePmc = {
    search: fake.deps.europePmc.search.bind(fake.deps.europePmc),
    fullText: () => Promise.reject(error),
    grants: fake.deps.europePmc.grants.bind(fake.deps.europePmc),
  };
  return fake;
}

describe("a run over the back catalogue", () => {
  it("reads every paper, records the references, and publishes the page", async () => {
    const fake = fakeDeps();
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result).toMatchObject({
      found: 8,
      read: 7,
      failed: 1,
      published: { published: true, references: 8 },
    });

    const row = fake.table.rows.get("PMC0000001");
    expect(row?.status).toBe("processed");
    expect(row?.references?.map((r) => r.normalised)).toEqual([
      "C1234/A56789",
      "CTRQQR-2021/100010",
      "A28707",
    ]);
    expect(row?.versions).toEqual({ rules: "rules-4", code: "test" });
    expect(fake.table.rows.get("PMC0000003")?.references).toEqual([]);

    const page = fake.site.files?.["index.html"] ?? "";
    expect(page).toContain("What it found");
    expect(page).toContain("RRCOER-Jun24/100008");
    expect(page).toContain("https://europepmc.org/article/PMC/PMC0000002");
  });

  it("reads the papers recorded from Europe PMC, and finds their references", async () => {
    const fake = fakeDeps();
    await runWith(fake);
    for (const entry of RECORDED) {
      expect(fake.table.rows.get(entry.pmcid)?.status).toBe("processed");
    }
    const references = (pmcid: string) =>
      fake.table.rows.get(pmcid)?.references?.map((r) => r.normalised);
    expect(references("PMC13628515")).toEqual([
      "C9685/A25117",
      "SEBCATP-2024/100008",
    ]);
    expect(references("PMC13642255")).toEqual(["C47608/A29957"]);
    // A CRUK studentship with no grant id gives no reference.
    expect(references("PMC13664392")).toEqual([]);
    // A bare number the metadata gives CRUK, and the acknowledgements repeat.
    expect(references("PMC13401056")).toEqual(["28275"]);

    const page = fake.site.files?.["index.html"] ?? "";
    expect(page).toContain("C9685/A25117");
    expect(page).toContain("C47608/A29957");
    expect(page).toContain("https://europepmc.org/article/PMC/PMC13628515");
  });

  it("keeps the funding text in the bucket, and only there", () => {
    const fake = fakeDeps();
    return runWith(fake).then(() => {
      expect(JSON.stringify([...fake.text.values()])).toContain("Quillfeather");
    });
  });

  it("leaves a paper it could not read for the next run, which reads only what is left", async () => {
    const fake = fakeDeps();
    await runWith(fake);
    expect(fake.table.rows.get("PMC0000004")).toMatchObject({
      status: "pending",
      failures: 1,
    });
    expect(fake.site.files?.["index.html"]).toContain(
      "A made-up study whose full text fails.",
    );

    fake.requests.length = 0;
    const again = await runWith(fake);
    expect(again.result?.read).toBe(0);
    const read = fake.requests.filter((url) =>
      url.pathname.endsWith("fullTextXML"),
    );
    expect(new Set(read.map((url) => url.pathname))).toEqual(
      new Set(["/europepmc/webservices/rest/PMC0000004/fullTextXML"]),
    );
  });

  it("publishes again when a later run reads nothing but the table holds a paper read", async () => {
    const fake = fakeDeps();
    await runWith(fake);
    fake.site.files = undefined;

    const again = await runWith(fake);
    expect(again.status).toBe("SUCCEEDED");
    expect(again.result?.read).toBe(0);
    expect(again.result?.published).toEqual({
      published: true,
      papers: 8,
      references: 8,
      page: "written",
    });
    expect(fake.site.files?.["index.html"]).toContain("RRCOER-Jun24/100008");
  });
});

// A deploy can land while a run is reading, and the run stays on the
// version it started on (#73).
describe("a run that finishes after a deploy", () => {
  it("leaves a newer deploy's page, and publishes its data", async () => {
    const fake = fakeDeps();
    fake.deps.release = () => Promise.resolve(fakeRelease(200));
    fake.site.live = JSON.stringify(fakeRelease(300));
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.published).toMatchObject({ published: true, page: "left" });
    expect(fake.site.files?.["index.html"]).toBeUndefined();
    expect(fake.site.files?.["found.json"]).toContain("RRCOER-Jun24/100008");
  });

  it("writes the page as before when its own deploy is the live one", async () => {
    const fake = fakeDeps();
    fake.deps.release = () => Promise.resolve(fakeRelease(300));
    fake.site.live = JSON.stringify(fakeRelease(300));
    const { result } = await runWith(fake);
    expect(result?.published).toMatchObject({ page: "written" });
    expect(fake.site.files?.["index.html"]).toContain("RRCOER-Jun24/100008");
    expect(fake.site.files?.["found.json"]).toContain("RRCOER-Jun24/100008");
  });
});

describe("a paper Europe PMC has since linked to a grant", () => {
  it("is neither listed nor counted once a later complete search no longer returns it", async () => {
    const fake = fakeDeps();
    const first = await runWith(fake);
    expect(fake.site.files?.["index.html"]).toContain("Another made-up study.");
    // Counted from the first run, so a change to the rules that finds more
    // or fewer references in the fixtures leaves this test as it is.
    const before = first.result?.published;
    if (before?.published !== true)
      throw new Error("the first run did not publish");
    const dropped = fake.table.rows.get("PMC0000002")?.references?.length ?? 0;
    expect(dropped).toBeGreaterThan(0);

    // Europe PMC now links PMC0000002 to a grant, so the search for papers
    // linked to none leaves it out.
    const search = fake.deps.europePmc.search.bind(fake.deps.europePmc);
    fake.deps.europePmc.search = async (...args) => {
      const page = await search(...args);
      return {
        ...page,
        papers: page.papers.filter((paper) => paper.pmcid !== "PMC0000002"),
      };
    };
    fake.deps.now = () => "2026-12-09T12:00:00.000Z";

    const again = await runWith(fake);
    expect(again.status).toBe("SUCCEEDED");
    expect(again.result?.published).toEqual({
      published: true,
      papers: before.papers - 1,
      references: before.references - dropped,
      page: "written",
    });
    const page = fake.site.files?.["index.html"] ?? "";
    expect(page).not.toContain("Another made-up study.");
    expect(page).not.toContain("RRCOER-Jun24/100008");
    const data = found.parse(
      JSON.parse(fake.site.files?.["found.json"] ?? "{}"),
    );
    expect(data.papers.map((paper) => paper.pmcid)).not.toContain("PMC0000002");
    expect(data.counts.papers).toBe(7);
    // The table keeps the paper and what was read from it.
    expect(fake.table.rows.get("PMC0000002")).toMatchObject({
      status: "processed",
    });
  });
});

describe("fitness: no name reaches the table, the logs or the page (personal-data.md)", () => {
  it("finds the fixtures' names nowhere but the bucket", async () => {
    const fake = fakeDeps();
    await runWith(fake);
    expect(NAMES.length).toBeGreaterThan(0);
    const table = JSON.stringify([...fake.table.rows.values()]);
    const page = fake.site.files?.["index.html"] ?? "";
    const data = fake.site.files?.["found.json"] ?? "";
    const logged = logs.join("\n");
    expect(logged).toContain("paper-read");
    for (const name of NAMES) {
      expect(table).not.toContain(name);
      expect(page).not.toContain(name);
      expect(data).not.toContain(name);
      expect(logged).not.toContain(name);
    }
  });
});

describe("a run that fails, finds nothing, or finds no paper read in the table leaves the page as it was", () => {
  it("publishes nothing when the search fails", async () => {
    const fake = fakeDeps({ search: () => reply("", 503) });
    const { status } = await runWith(fake);
    expect(status).toBe("FAILED");
    expect(fake.site.files).toBeUndefined();
  });

  it("fails when the whole search skipped results for a malformed PMCID and found no papers", async () => {
    const fake = fakeDeps({ search: malformedPage });
    const { status, error } = await runWith(fake);
    expect(status).toBe("FAILED");
    expect(error).toContain(
      "the search skipped 2 results for a malformed PMCID and found no papers",
    );
    expect(fake.site.files).toBeUndefined();
  });

  it("publishes what the search found when a small last page holds one malformed PMCID alone", async () => {
    const fake = fakeDeps({
      search: smallLastPageMalformed(["PMC0000001", "PMC0000002"]),
    });
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result).toMatchObject({
      found: 2,
      published: { published: true },
    });
    expect(fake.site.files?.["index.html"]).toBeDefined();
  });

  it("publishes nothing when the search finds nothing", async () => {
    const fake = fakeDeps({
      search: () =>
        reply(JSON.stringify({ hitCount: 0, resultList: { result: [] } })),
    });
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.published).toEqual({
      published: false,
      reason: "the search found nothing",
    });
    expect(fake.site.files).toBeUndefined();
  });

  it("asks again for a paper Europe PMC kept refusing, but not for one it has no full text for, nor after a fault of its own", async () => {
    const asked = async (error: Error) => {
      const fake = fakeDeps();
      const calls = new Map<string, number>();
      fake.deps.europePmc = {
        search: fake.deps.europePmc.search.bind(fake.deps.europePmc),
        fullText: (pmcid) => {
          calls.set(pmcid, (calls.get(pmcid) ?? 0) + 1);
          return Promise.reject(error);
        },
        grants: fake.deps.europePmc.grants.bind(fake.deps.europePmc),
      };
      // Count only the run's own reads, not the snapshot's.
      fake.deps.text.hasSnapshot = () => Promise.resolve(true);
      await runWith(fake);
      return calls.get("PMC0000001");
    };
    expect(
      await asked(
        new EuropePmcError("Europe PMC answered 429, after 5 tries", undefined),
      ),
    ).toBe(3);
    expect(
      await asked(
        new EuropePmcError("Europe PMC answered 503, after 5 tries", undefined),
      ),
    ).toBe(3);
    expect(
      await asked(new EuropePmcError("Europe PMC answered 404", 404)),
    ).toBe(1);
    // A fault in the paper or the code, such as a reply that does not
    // parse, gives the same result however often it is tried.
    expect(await asked(new Error("not the shape expected"))).toBe(1);
  });

  it("publishes nothing while the table holds no paper read", async () => {
    const fake = fakeDeps();
    fake.deps.europePmc = {
      search: fake.deps.europePmc.search.bind(fake.deps.europePmc),
      fullText: () =>
        Promise.reject(new Error("Europe PMC answered 503, after 5 tries")),
      grants: fake.deps.europePmc.grants.bind(fake.deps.europePmc),
    };
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.published).toEqual({
      published: false,
      reason: "nothing read",
    });
    expect(fake.site.files).toBeUndefined();
  });
});

// Europe PMC refusing every full text with a Retry-After of `seconds`,
// from the run's first paper or from the start of the snapshot on, however
// the snapshot draws gold set A. It records each request sent before the
// last refusal's wait had passed. The local runner moves Date.now() on
// through each durable wait.
function refusingFor(seconds: number, from: "run" | "snapshot") {
  const fake = fakeDeps();
  const real = fake.deps.europePmc;
  let refusing = from === "run";
  const hasSnapshot = fake.deps.text.hasSnapshot.bind(fake.deps.text);
  fake.deps.text.hasSnapshot = (id) => {
    refusing = true;
    return hasSnapshot(id);
  };
  let notBefore = 0;
  const early: string[] = [];
  const refused: string[] = [];
  const check = (request: string) => {
    if (Date.now() < notBefore) early.push(request);
  };
  fake.deps.europePmc = {
    search: (cursor, selection, pageSize) => {
      check("search");
      return real.search(cursor, selection, pageSize);
    },
    grants: (pmcid) => {
      check(`grants ${pmcid}`);
      return real.grants(pmcid);
    },
    fullText: (pmcid) => {
      check(`fullText ${pmcid}`);
      if (!refusing) return real.fullText(pmcid);
      refused.push(pmcid);
      notBefore = Date.now() + seconds * 1_000;
      return Promise.reject(
        new EuropePmcError(
          `Europe PMC answered 429, asked to wait ${String(seconds)}s`,
          429,
          seconds,
        ),
      );
    },
  };
  return { fake, early, refused };
}

describe("fitness: a step Europe PMC refused waits before asking again (europe-pmc.md)", () => {
  it("waits as long as a search's Retry-After asks, when that is longer than the client waits", async () => {
    const fake = fakeDeps({
      search: () => reply("", 429, { "Retry-After": "300" }),
    });
    const { status, retryDelays } = await runWith(fake);
    expect(status).toBe("FAILED");
    const delays = retryDelays("search-0");
    expect(delays).toHaveLength(2);
    for (const delay of delays) expect(delay).toBeGreaterThanOrEqual(300);
  });

  it("waits as long as a paper's Retry-After asks", async () => {
    const fake = refusingPapers(
      new EuropePmcError(
        "Europe PMC answered 429, asked to wait 900s",
        429,
        900,
      ),
    );
    const { retryDelays } = await runWith(fake);
    const delays = retryDelays("paper-PMC0000001");
    expect(delays).toHaveLength(2);
    for (const delay of delays) expect(delay).toBeGreaterThanOrEqual(900);
  });

  it("leaves a paper for the next run when Europe PMC asks for more than an hour", async () => {
    const fake = refusingPapers(
      new EuropePmcError(
        "Europe PMC answered 429, asked to wait 7200s",
        429,
        7200,
      ),
    );
    const { status, retryDelays } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(retryDelays("paper-PMC0000001")).toEqual([]);
    expect(fake.table.rows.get("PMC0000001")).toMatchObject({
      status: "pending",
      failures: 1,
    });
  });

  it.each([300, 7200])(
    "asks Europe PMC nothing more until a refused paper's Retry-After of %is has passed",
    async (seconds) => {
      const { fake, early, refused } = refusingFor(seconds, "run");
      fake.deps.text.hasSnapshot = () => Promise.resolve(true);
      const { status, result } = await runWith(fake);
      expect(status).toBe("SUCCEEDED");
      // Every paper was asked about in the end, each after the wait.
      expect(result?.found).toBeGreaterThan(1);
      expect(new Set(refused).size).toBe(result?.found);
      expect(early).toEqual([]);
    },
  );

  it.each([300, 7200])(
    "asks nothing more until a refused gold paper's Retry-After of %is has passed",
    async (seconds) => {
      const { fake, early, refused } = refusingFor(seconds, "snapshot");
      const { status } = await runWith(fake);
      expect(status).toBe("SUCCEEDED");
      expect(new Set(refused).size).toBeGreaterThan(1);
      expect(early).toEqual([]);
    },
  );

  it("never asks again sooner than its first wait, with no Retry-After", async () => {
    const search = await runWith(fakeDeps({ search: () => reply("", 503) }));
    const paper = await runWith(
      refusingPapers(
        new EuropePmcError("Europe PMC answered 503, after 5 tries", undefined),
      ),
    );
    const delays = [
      ...search.retryDelays("search-0"),
      ...paper.retryDelays("paper-PMC0000001"),
    ];
    expect(delays).toHaveLength(4);
    for (const delay of delays) expect(delay).toBeGreaterThanOrEqual(30);
  });
});

describe("a failure to write or read the table is retried apart from Europe PMC's search", () => {
  // The run's own searches of Europe PMC, not the snapshot's or a paper's.
  const runSearches = (fake: ReturnType<typeof fakeDeps>) =>
    fake.requests.filter(
      (url) =>
        url.searchParams.get("resultType") === "lite" && !isGoldSearch(url),
    ).length;

  // A table whose `method` fails `times` times, then works as before.
  function failingTable(method: "addFound" | "processed", times: number) {
    const fake = fakeDeps();
    const real = fake.table[method].bind(fake.table) as (
      ...args: never[]
    ) => Promise<unknown>;
    let failures = 0;
    const flaky = (...args: never[]) => {
      if (failures < times) {
        failures += 1;
        return Promise.reject(new Error("DynamoDB read none of the keys"));
      }
      return real(...args);
    };
    Object.assign(fake.deps.table, { [method]: flaky });
    return fake;
  }

  it("asks Europe PMC for 150 results a page, which fits in a checkpoint", async () => {
    const fake = fakeDeps();
    await runWith(fake);
    const sizes = fake.requests
      .filter(
        (url) =>
          url.searchParams.get("resultType") === "lite" && !isGoldSearch(url),
      )
      .map((url) => url.searchParams.get("pageSize"));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBe("150");
  });

  for (const method of ["addFound", "processed"] as const) {
    it(`does not call Europe PMC again or use up its retries when ${method} keeps failing`, async () => {
      const fake = failingTable(method, Infinity);
      const { status, retryDelays } = await runWith(fake);
      expect(status).toBe("FAILED");
      expect(runSearches(fake)).toBe(1);
      expect(retryDelays("search-0")).toEqual([]);
    });

    it(`retries ${method} under the store's strategy, and carries on`, async () => {
      const fake = failingTable(method, 2);
      const { status, result, retryDelays } = await runWith(fake);
      expect(status).toBe("SUCCEEDED");
      expect(result).toMatchObject({ found: 8, read: 7 });
      // Two pages, each searched once.
      expect(runSearches(fake)).toBe(2);
      expect(retryDelays("search-0")).toEqual([]);
      // storeRetry starts at five seconds; Europe PMC's at thirty.
      const delays = retryDelays("record-0");
      expect(delays).toHaveLength(2);
      for (const delay of delays) expect(delay).toBeLessThan(30);
    });
  }
});

describe("the eval snapshot (evals.md)", () => {
  const manifestOf = (fake: ReturnType<typeof fakeDeps>) =>
    JSON.parse(String(fake.text.get("eval/s1/manifest.json"))) as {
      id: string;
      goldA: { seed: number };
      papers: {
        pmcid: string;
        set: string;
        sha256: string;
        grants: string[];
      }[];
    };

  it("samples gold set A once, keeps each paper's text under eval/, and writes a manifest of ids, hashes and grant ids", async () => {
    const fake = fakeDeps();
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toMatchObject({ taken: true, papers: 2 });
    expect(fake.requests.some(isGoldSearch)).toBe(true);

    const manifest = manifestOf(fake);
    expect(manifest.id).toBe("s1");
    expect(manifest.papers.map((paper) => paper.pmcid).sort()).toEqual([
      "PMC0000001",
      "PMC0000002",
    ]);
    const one = manifest.papers.find((paper) => paper.pmcid === "PMC0000001");
    expect(one).toMatchObject({ set: "A", grants: ["A56789"] });
    const text = String(fake.text.get("eval/papers/PMC0000001.json"));
    expect(createHash("sha256").update(text).digest("hex")).toBe(one?.sha256);
    expect(text).toContain("Quillfeather");
    // The gold papers' text goes to cache/ too.
    expect(fake.text.has("cache/PMC0000002.json")).toBe(true);
    // The manifest holds no text and no name.
    for (const name of NAMES) {
      expect(JSON.stringify(manifest)).not.toContain(name);
    }
  });

  it("takes no second snapshot, and never rewrites the first", async () => {
    const fake = fakeDeps();
    await runWith(fake);
    const first = fake.text.get("eval/s1/manifest.json");
    fake.requests.length = 0;
    const again = await runWith(fake);
    expect(again.result?.snapshot).toEqual({
      taken: false,
      reason: "already taken",
    });
    expect(fake.text.get("eval/s1/manifest.json")).toBe(first);
    expect(fake.requests.some(isGoldSearch)).toBe(false);
  });

  it("writes no manifest when every PMCID gold set A's search finds is malformed", async () => {
    const fake = fakeDeps({ goldSearch: malformedPage });
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toEqual({ taken: false, reason: "failed" });
    expect(fake.text.has("eval/s1/manifest.json")).toBe(false);
  });

  it("takes the snapshot when a small last page of gold set A's search holds one malformed PMCID alone", async () => {
    const fake = fakeDeps({
      goldSearch: smallLastPageMalformed([
        "PMC0000001",
        "PMC0000002",
        "PMC0000003",
      ]),
    });
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toMatchObject({ taken: true });
    expect(fake.text.has("eval/s1/manifest.json")).toBe(true);
  });

  it("publishes the page even when the snapshot fails, and leaves it for the next run", async () => {
    const fake = fakeDeps();
    fake.deps.text.hasSnapshot = () =>
      Promise.reject(new Error("S3 answered 503"));
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.published).toMatchObject({ published: true });
    expect(result?.snapshot).toEqual({ taken: false, reason: "failed" });
    expect(fake.text.has("eval/s1/manifest.json")).toBe(false);
  });
});
