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
import { snapshotKeys } from "../../evals/gold.ts";
import {
  FAKE_GOLD,
  fakeDeps,
  fakeRelease,
  type FakeOptions,
  isGoldSearch,
  reply,
} from "../../test/fakes.ts";
import { NAMES, RECORDED } from "../../test/fixtures.ts";
import { europePmc, EuropePmcError } from "../europepmc/client.ts";
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
// Keeps each line the run logs in `logs`.
function keepLine(...args: unknown[]): void {
  logs.push(args.map(String).join(" "));
}
const spy = vi.spyOn(console, "log").mockImplementation(keepLine);
afterEach(() => {
  logs.length = 0;
  spy.mockImplementation(keepLine);
});

// Makes every try to log a line with event `event` throw, so the step that
// logs it fails after its retries (#380).
function failToLog(event: string) {
  spy.mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (
      line.startsWith("{") &&
      (JSON.parse(line) as { event?: unknown }).event === event
    ) {
      throw new Error(`could not log ${event}`);
    }
    logs.push(line);
  });
}
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

// A search whose first page holds two papers and one malformed PMCID, and
// whose next page Europe PMC answers with `later`.
const laterPageFails =
  (later: () => ReturnType<typeof reply>) => (cursor: string) =>
    cursor === "*"
      ? reply(
          JSON.stringify({
            hitCount: 4,
            nextCursorMark: "AoE",
            resultList: {
              result: [
                { pmcid: "PMC0000001" },
                { pmcid: "PMC0000002" },
                { pmcid: "PMC 3" },
              ],
            },
          }),
        )
      : later();

// A paper step whose full text Europe PMC refuses every time with `error`.
function refusingPapers(error: Error) {
  const fake = fakeDeps();
  fake.deps.europePmc = {
    search: fake.deps.europePmc.search.bind(fake.deps.europePmc),
    fullText: () => Promise.reject(error),
    grants: fake.deps.europePmc.grants.bind(fake.deps.europePmc),
    sent: fake.deps.europePmc.sent.bind(fake.deps.europePmc),
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
    expect(row?.versions).toEqual({ rules: "rules-20", code: "test" });
    expect(fake.table.rows.get("PMC0000003")?.references).toEqual([]);

    const page = fake.site.files?.["index.html"] ?? "";
    expect(page).toContain("What it found");
    expect(page).toContain("RRCOER-JUN24/100008");
    expect(page).toContain("https://europepmc.org/article/PMC/PMC0000002");
  });

  it("records its search as the latest complete one once the search ends (#125)", async () => {
    const fake = fakeDeps();
    const { result } = await runWith(fake);
    expect(result?.runId).toBe("run-2026-11-09T12:00:00.000Z");
    expect(fake.table.search.latest).toBe(result?.runId);
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
    const first = await runWith(fake);
    // Counted from the first run, so a change to the fixtures or the rules
    // leaves this test as it is.
    const before = first.result?.published;
    if (before?.published !== true)
      throw new Error("the first run did not publish");
    expect(before.papers).toBeGreaterThan(0);
    expect(before.references).toBeGreaterThan(0);
    fake.site.files = undefined;

    const again = await runWith(fake);
    expect(again.status).toBe("SUCCEEDED");
    expect(again.result?.read).toBe(0);
    expect(again.result?.published).toEqual({
      published: true,
      papers: before.papers,
      references: before.references,
      page: "written",
    });
    expect(fake.site.files?.["index.html"]).toContain("RRCOER-JUN24/100008");
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
    expect(fake.site.files?.["index.html"]).toContain("RRCOER-JUN24/100008");
    expect(fake.site.files?.["found.json"]).toContain("RRCOER-Jun24/100008");
  });
});

describe("a paper Europe PMC has since linked to a grant", () => {
  it("is neither listed nor counted once a later complete search no longer returns it", async () => {
    const fake = fakeDeps();
    const first = await runWith(fake);
    expect(fake.site.files?.["index.html"]).toContain("Another made-up study.");
    // Counted from the first run, so a change to the rules that finds more
    // or fewer references, or a fixture paper added or removed, leaves this
    // test as it is.
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
    expect(page).not.toContain("RRCOER-JUN24/100008");
    const data = found.parse(
      JSON.parse(fake.site.files?.["found.json"] ?? "{}"),
    );
    expect(data.papers.map((paper) => paper.pmcid)).not.toContain("PMC0000002");
    expect(data.counts.papers).toBe(before.papers - 1);
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

  it("reports how many results it skipped for a malformed PMCID, in its result and once in the logs", async () => {
    const fake = fakeDeps({
      search: smallLastPageMalformed(["PMC0000001", "PMC0000002"]),
    });
    const { result } = await runWith(fake);
    expect(result).toMatchObject({ found: 2, skipped: 1 });
    expect(logged("search-ended")).toEqual([
      expect.objectContaining({
        found: 2,
        skipped: 1,
        refused: false,
        failed: false,
      }),
    ]);
  });

  it("logs how many results it skipped for a malformed PMCID before the search fails the run", async () => {
    const fake = fakeDeps({ search: malformedPage });
    const { status } = await runWith(fake);
    expect(status).toBe("FAILED");
    expect(logged("search-ended")).toEqual([
      expect.objectContaining({ found: 0, skipped: 2 }),
    ]);
  });

  it.each([
    [
      "refuses",
      () => reply("", 429, { "Retry-After": "300" }),
      true,
      false,
      "Europe PMC refused the run's search",
    ],
    [
      "fails without a refusal",
      () => reply("", 503),
      false,
      true,
      "Europe PMC answered 503",
    ],
  ] as const)(
    "logs once how many results the pages it read found and skipped when Europe PMC %s a later page of the run's search (#348)",
    async (_how, later, refused, failed, why) => {
      const fake = fakeDeps({ search: laterPageFails(later) });
      const { status, error } = await runWith(fake);
      expect(status).toBe("FAILED");
      // The run fails with the search's own error, not the log step's.
      expect(error).toContain(why);
      expect(logged("search-ended")).toEqual([
        expect.objectContaining({ found: 2, skipped: 1, refused, failed }),
      ]);
    },
  );

  it("still judges, records and publishes its search when its search-ended step fails (#380)", async () => {
    const fake = fakeDeps();
    failToLog("search-ended");
    const { status, result, retryDelays } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(retryDelays("search-ended")).not.toEqual([]);
    expect(fake.table.search.latest).toBe(result?.runId);
    expect(result?.published).toMatchObject({ published: true });
    expect(fake.site.files).toBeDefined();
    expect(logged("search-ended")).toEqual([]);
  });

  it("still fails a search that skipped results and found no papers when its search-ended step fails (#380)", async () => {
    const fake = fakeDeps({ search: malformedPage });
    failToLog("search-ended");
    const { status, error, retryDelays } = await runWith(fake);
    expect(status).toBe("FAILED");
    expect(retryDelays("search-ended")).not.toEqual([]);
    expect(error).toContain("malformed PMCID");
    expect(fake.site.files).toBeUndefined();
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
    expect(fake.table.search.latest).toBeNull();
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
        sent: fake.deps.europePmc.sent.bind(fake.deps.europePmc),
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
      sent: fake.deps.europePmc.sent.bind(fake.deps.europePmc),
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
// last refusal's wait had passed, and when that wait ends. The local
// runner moves Date.now() on through each durable wait.
function refusingFor(
  seconds: number,
  from: "run" | "snapshot",
  options: FakeOptions = {},
) {
  const fake = fakeDeps(options);
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
    sent: real.sent.bind(real),
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
  return { fake, early, refused, notBefore: () => notBefore };
}

// Europe PMC refusing only the run's last paper, with a Retry-After of two
// hours. It records each request sent before that wait had passed, and
// when the page was published.
async function refusingLast() {
  // The order the run reads its papers in.
  const order: string[] = [];
  const dry = fakeDeps();
  const fullText = dry.deps.europePmc.fullText.bind(dry.deps.europePmc);
  dry.deps.europePmc.fullText = (pmcid) => {
    order.push(pmcid);
    return fullText(pmcid);
  };
  dry.deps.text.hasSnapshot = () => Promise.resolve(true);
  await runWith(dry);
  const last = order.at(-1);
  if (last === undefined) throw new Error("the dry run read no paper");

  const fake = fakeDeps();
  const real = fake.deps.europePmc;
  const seen = { notBefore: 0, publishedAt: 0, early: [] as string[] };
  const check = (request: string) => {
    if (Date.now() < seen.notBefore) seen.early.push(request);
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
    sent: real.sent.bind(real),
    fullText: (pmcid) => {
      check(`fullText ${pmcid}`);
      if (pmcid !== last) return real.fullText(pmcid);
      seen.notBefore = Date.now() + 7_200_000;
      return Promise.reject(
        new EuropePmcError(
          "Europe PMC answered 429, asked to wait 7200s",
          429,
          7200,
        ),
      );
    },
  };
  const publish = fake.deps.site.publish.bind(fake.deps.site);
  fake.deps.site.publish = (files) => {
    seen.publishedAt = Date.now();
    return publish(files);
  };
  return { fake, seen, last };
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

  it("does not hold back the publish step for a refusal on the run's last paper", async () => {
    const { fake, seen } = await refusingLast();
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.published).toMatchObject({ published: true });
    expect(seen.notBefore).toBeGreaterThan(0);
    expect(seen.publishedAt).toBeGreaterThan(0);
    expect(seen.publishedAt).toBeLessThan(seen.notBefore);
    // The snapshot, which asks Europe PMC, still waits.
    expect(result?.snapshot).toMatchObject({ taken: true });
    expect(seen.early).toEqual([]);
  });

  it("ends only once a refusal on its last paper has been waited out, when there is no snapshot to take", async () => {
    const { fake, seen } = await refusingLast();
    fake.deps.text.hasSnapshot = () => Promise.resolve(true);
    const { status, ended } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(seen.publishedAt).toBeLessThan(seen.notBefore);
    expect(ended).toBeGreaterThanOrEqual(seen.notBefore);
  });

  it("ends only once a refusal on its last paper has been waited out, when the snapshot and its snapshot-failed step both fail (#380)", async () => {
    const { fake, seen } = await refusingLast();
    fake.deps.text.hasSnapshot = () =>
      Promise.reject(new Error("S3 answered 503"));
    failToLog("snapshot-failed");
    const { status, result, ended, retryDelays } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(retryDelays("snapshot-failed")).not.toEqual([]);
    expect(logged("snapshot-failed")).toEqual([]);
    expect(result?.snapshot).toEqual({ taken: false, reason: "failed" });
    expect(seen.notBefore).toBeGreaterThan(0);
    expect(ended).toBeGreaterThanOrEqual(seen.notBefore);
  });

  it.each(["recordSearch", "publish"] as const)(
    "fails only once a refusal on its last paper has been waited out, when %s fails after its retries (#412)",
    async (method) => {
      const { fake, seen } = await refusingLast();
      const answered =
        method === "publish" ? "S3 answered 503" : "DynamoDB answered 503";
      const failing = () => Promise.reject(new Error(answered));
      if (method === "publish") fake.deps.site.publish = failing;
      else fake.deps.table.recordSearch = failing;
      const { status, error, ended, retryDelays } = await runWith(fake);
      expect(status).toBe("FAILED");
      expect(error).toContain(answered);
      expect(
        retryDelays(method === "publish" ? "publish" : "searched"),
      ).not.toEqual([]);
      expect(seen.notBefore).toBeGreaterThan(0);
      expect(ended).toBeGreaterThanOrEqual(seen.notBefore);
    },
  );

  it("fails when publish fails after its retries and no refusal left a wait owed (#412)", async () => {
    const fake = fakeDeps();
    fake.deps.text.hasSnapshot = () => Promise.resolve(true);
    fake.deps.site.publish = () => Promise.reject(new Error("S3 answered 503"));
    const { status, error, retryDelays } = await runWith(fake);
    expect(status).toBe("FAILED");
    expect(error).toContain("S3 answered 503");
    expect(retryDelays("publish")).not.toEqual([]);
  });

  it("fails only once a refusal on its last paper has been waited out, when marking that paper failed fails after its retries (#412)", async () => {
    const { fake, seen, last } = await refusingLast();
    const markFailed = fake.deps.table.markFailed.bind(fake.deps.table);
    fake.deps.table.markFailed = (pmcid, why) =>
      pmcid === last
        ? Promise.reject(new Error("DynamoDB answered 503"))
        : markFailed(pmcid, why);
    const { status, error, ended, retryDelays } = await runWith(fake);
    expect(status).toBe("FAILED");
    expect(error).toContain("DynamoDB answered 503");
    expect(retryDelays(`failed-${last}`)).not.toEqual([]);
    expect(seen.notBefore).toBeGreaterThan(0);
    expect(ended).toBeGreaterThanOrEqual(seen.notBefore);
  });

  it.each([300, 7200])(
    "ends only once a refusal of gold set A's search with a Retry-After of %is has been waited out, when that fails the snapshot (#236)",
    async (seconds) => {
      const fake = fakeDeps({
        goldSearch: () => reply("", 429, { "Retry-After": String(seconds) }),
      });
      const started = Date.now();
      const { status, result, ended, retryDelays } = await runWith(fake);
      expect(status).toBe("SUCCEEDED");
      expect(result?.published).toMatchObject({ published: true });
      expect(result?.snapshot).toEqual({
        taken: false,
        reason: "Europe PMC refused gold set A's search",
      });
      // The step's own retries wait first, then the run waits out the wait
      // its last refusal asked for.
      const retried = retryDelays("snapshot-search-0").reduce(
        (sum, delay) => sum + delay,
        0,
      );
      expect(ended - started).toBeGreaterThanOrEqual(
        (retried + seconds) * 1000,
      );
    },
  );

  it.each([300, 7200])(
    "ends only once a refused last gold set A paper's Retry-After of %is has been waited out, when gold set B lists no papers and the manifest write fails (#284)",
    async (seconds) => {
      const { fake, early, notBefore } = refusingFor(seconds, "snapshot", {
        gold: { goldB: { ...FAKE_GOLD.goldB, papers: [] } },
      });
      fake.deps.text.putManifest = () =>
        Promise.reject(new Error("S3 answered 503"));
      const { status, result, ended } = await runWith(fake);
      expect(status).toBe("SUCCEEDED");
      expect(result?.snapshot).toEqual({ taken: false, reason: "failed" });
      expect(early).toEqual([]);
      expect(notBefore()).toBeGreaterThan(0);
      expect(ended).toBeGreaterThanOrEqual(notBefore());
    },
  );

  it("fails only once a refusal of the run's search has been waited out, when its search-ended step fails (#380)", async () => {
    const fake = fakeDeps({
      search: () => reply("", 429, { "Retry-After": "300" }),
    });
    failToLog("search-ended");
    const started = Date.now();
    const { status, error, ended, retryDelays } = await runWith(fake);
    expect(status).toBe("FAILED");
    expect(retryDelays("search-ended")).not.toEqual([]);
    expect(error).toContain("Europe PMC refused the run's search");
    expect(fake.site.files).toBeUndefined();
    const retried = retryDelays("search-0").reduce(
      (sum, delay) => sum + delay,
      0,
    );
    expect(ended - started).toBeGreaterThanOrEqual((retried + 300) * 1000);
  });

  it.each([300, 7200])(
    "fails only once a refusal of the run's search with a Retry-After of %is has been waited out (#264)",
    async (seconds) => {
      const fake = fakeDeps({
        search: () => reply("", 429, { "Retry-After": String(seconds) }),
      });
      const started = Date.now();
      const { status, error, ended, retryDelays } = await runWith(fake);
      expect(status).toBe("FAILED");
      expect(error).toContain("Europe PMC refused the run's search");
      expect(fake.site.files).toBeUndefined();
      // The step's own retries wait first, then the run waits out the wait
      // its last refusal asked for before it fails.
      const retried = retryDelays("search-0").reduce(
        (sum, delay) => sum + delay,
        0,
      );
      expect(ended - started).toBeGreaterThanOrEqual(
        (retried + seconds) * 1000,
      );
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
  const MANIFEST = snapshotKeys.manifest(FAKE_GOLD.snapshotId);
  const manifestOf = (fake: ReturnType<typeof fakeDeps>) =>
    JSON.parse(String(fake.text.get(MANIFEST))) as {
      id: string;
      goldA: { seed: number };
      papers: {
        pmcid: string;
        set: string;
        sha256: string;
        grants: string[];
      }[];
    };

  it("samples gold set A once, reads every labelled gold set B paper, keeps each paper's text under eval/, and writes a manifest of ids, hashes and grant ids", async () => {
    const fake = fakeDeps();
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toMatchObject({
      taken: true,
      papers: 2 + FAKE_GOLD.goldB.papers.length,
    });
    expect(fake.requests.some(isGoldSearch)).toBe(true);

    const manifest = manifestOf(fake);
    expect(manifest.id).toBe(FAKE_GOLD.snapshotId);
    const inSet = (set: string) =>
      manifest.papers
        .filter((paper) => paper.set === set)
        .map((paper) => paper.pmcid)
        .sort();
    expect(inSet("A")).toEqual(["PMC0000001", "PMC0000002"]);
    expect(inSet("B")).toEqual(
      FAKE_GOLD.goldB.papers.map((paper) => paper.pmcid).sort(),
    );
    const one = manifest.papers.find((paper) => paper.pmcid === "PMC0000001");
    expect(one).toMatchObject({ set: "A", grants: ["A56789"] });
    const text = String(
      fake.text.get(snapshotKeys.paper(FAKE_GOLD.snapshotId, "PMC0000001")),
    );
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
    const first = fake.text.get(MANIFEST);
    fake.requests.length = 0;
    const again = await runWith(fake);
    expect(again.result?.snapshot).toEqual({
      taken: false,
      reason: "already taken",
    });
    expect(fake.text.get(MANIFEST)).toBe(first);
    expect(fake.requests.some(isGoldSearch)).toBe(false);
  });

  it("writes no manifest when every PMCID gold set A's search finds is malformed", async () => {
    const fake = fakeDeps({ goldSearch: malformedPage });
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toEqual({ taken: false, reason: "failed" });
    expect(fake.text.has(MANIFEST)).toBe(false);
    expect(snapshotFailedFields()).toEqual({ reason: "malformed-search" });
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
    expect(fake.text.has(MANIFEST)).toBe(true);
  });

  it("logs once how many results gold set A's search found and skipped for a malformed PMCID (#279)", async () => {
    const fake = fakeDeps({
      goldSearch: smallLastPageMalformed([
        "PMC0000001",
        "PMC0000002",
        "PMC0000003",
      ]),
    });
    const { result } = await runWith(fake);
    expect(result?.snapshot).toMatchObject({ taken: true });
    expect(logged("snapshot-search-ended")).toEqual([
      expect.objectContaining({
        runId: result?.runId,
        snapshotId: FAKE_GOLD.snapshotId,
        found: 3,
        skipped: 1,
        refused: false,
      }),
    ]);
  });

  it("logs how many results gold set A's search skipped before that search fails the snapshot (#279)", async () => {
    const fake = fakeDeps({ goldSearch: malformedPage });
    const { result } = await runWith(fake);
    expect(result?.snapshot).toEqual({ taken: false, reason: "failed" });
    expect(logged("snapshot-search-ended")).toEqual([
      expect.objectContaining({
        runId: result?.runId,
        snapshotId: FAKE_GOLD.snapshotId,
        found: 0,
        skipped: 2,
        refused: false,
      }),
    ]);
  });

  it("logs once how many results the pages it read found and skipped when Europe PMC refuses a later page of gold set A's search (#307)", async () => {
    const fake = fakeDeps({
      goldSearch: (cursor) =>
        cursor === "*"
          ? reply(
              JSON.stringify({
                hitCount: 4,
                nextCursorMark: "AoE",
                resultList: {
                  result: [
                    { pmcid: "PMC0000001" },
                    { pmcid: "PMC0000002" },
                    { pmcid: "PMC 3" },
                  ],
                },
              }),
            )
          : reply("", 429, { "Retry-After": "300" }),
    });
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toEqual({
      taken: false,
      reason: "Europe PMC refused gold set A's search",
    });
    expect(logged("snapshot-search-ended")).toEqual([
      expect.objectContaining({
        runId: result?.runId,
        snapshotId: FAKE_GOLD.snapshotId,
        found: 2,
        skipped: 1,
        refused: true,
        failed: false,
      }),
    ]);
  });

  it("logs once how many results the pages it read found and skipped when a later page of gold set A's search fails without a refusal (#348)", async () => {
    const fake = fakeDeps({ goldSearch: laterPageFails(() => reply("", 503)) });
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toEqual({ taken: false, reason: "failed" });
    expect(logged("snapshot-search-ended")).toEqual([
      expect.objectContaining({
        runId: result?.runId,
        snapshotId: FAKE_GOLD.snapshotId,
        found: 2,
        skipped: 1,
        refused: false,
        failed: true,
      }),
    ]);
  });

  it("logs once that gold set A's search found and skipped nothing when Europe PMC refuses its first page (#307)", async () => {
    const fake = fakeDeps({
      goldSearch: () => reply("", 429, { "Retry-After": "300" }),
    });
    const { result } = await runWith(fake);
    expect(result?.snapshot).toEqual({
      taken: false,
      reason: "Europe PMC refused gold set A's search",
    });
    expect(logged("snapshot-search-ended")).toEqual([
      expect.objectContaining({ found: 0, skipped: 0, refused: true }),
    ]);
    // A refused search loses the snapshot as surely as a failed one (#399).
    expect(snapshotFailedFields()).toEqual({ reason: "search-refused" });
  });

  // A failed snapshot-search-ended step leaves the search's own reason in
  // charge of how the snapshot ends, not its error (#370).
  describe("when the snapshot-search-ended step fails", () => {
    it("logs malformed-search, not unknown, for a malformed search", async () => {
      failToLog("snapshot-search-ended");
      const fake = fakeDeps({ goldSearch: malformedPage });
      const { status, result, retryDelays } = await runWith(fake);
      expect(status).toBe("SUCCEEDED");
      expect(retryDelays("snapshot-search-ended")).not.toEqual([]);
      expect(result?.snapshot).toEqual({ taken: false, reason: "failed" });
      expect(snapshotFailedFields()).toEqual({ reason: "malformed-search" });
    });

    it("ends with Europe PMC's refusal, not the step's error, when it refuses the search", async () => {
      failToLog("snapshot-search-ended");
      const fake = fakeDeps({
        goldSearch: () => reply("", 429, { "Retry-After": "300" }),
      });
      const started = Date.now();
      const { status, result, ended, retryDelays } = await runWith(fake);
      expect(status).toBe("SUCCEEDED");
      expect(retryDelays("snapshot-search-ended")).not.toEqual([]);
      expect(result?.snapshot).toEqual({
        taken: false,
        reason: "Europe PMC refused gold set A's search",
      });
      expect(snapshotFailedFields()).toEqual({ reason: "search-refused" });
      // The wait the refusal asked for is still owed, and waited out
      // before the run ends (#236).
      const retried = retryDelays("snapshot-search-0").reduce(
        (sum, delay) => sum + delay,
        0,
      );
      expect(ended - started).toBeGreaterThanOrEqual((retried + 300) * 1000);
    });

    it("logs search-failed, not unknown, when a page of the search fails", async () => {
      failToLog("snapshot-search-ended");
      const fake = fakeDeps({ goldSearch: () => reply("", 500) });
      const { status, result, retryDelays } = await runWith(fake);
      expect(status).toBe("SUCCEEDED");
      expect(retryDelays("snapshot-search-ended")).not.toEqual([]);
      expect(result?.snapshot).toEqual({ taken: false, reason: "failed" });
      expect(snapshotFailedFields()).toEqual({ reason: "search-failed" });
    });

    it("still takes the snapshot when the search is whole", async () => {
      failToLog("snapshot-search-ended");
      const fake = fakeDeps({
        goldSearch: smallLastPageMalformed([
          "PMC0000001",
          "PMC0000002",
          "PMC0000003",
        ]),
      });
      const { status, result, retryDelays } = await runWith(fake);
      expect(status).toBe("SUCCEEDED");
      expect(retryDelays("snapshot-search-ended")).not.toEqual([]);
      expect(result?.snapshot).toMatchObject({ taken: true });
    });
  });

  it("publishes the page even when the snapshot fails, and leaves it for the next run", async () => {
    const fake = fakeDeps();
    fake.deps.text.hasSnapshot = () =>
      Promise.reject(new Error("S3 answered 503"));
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.published).toMatchObject({ published: true });
    expect(result?.snapshot).toEqual({ taken: false, reason: "failed" });
    expect(fake.text.has(MANIFEST)).toBe(false);
    expect(snapshotFailedFields()).toEqual({ reason: "store-failed" });
    expect(logs.join("\n")).not.toContain("S3 answered 503");
  });

  // personal-data.md: a log line carries ids and counts, so the line logs
  // a fixed reason and never the message the snapshot threw (#285).
  it("logs store-failed, not the message, when the manifest cannot be written", async () => {
    const fake = fakeDeps();
    fake.deps.text.putManifest = () =>
      Promise.reject(new Error("S3 answered 503 for Quillfeather"));
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toEqual({ taken: false, reason: "failed" });
    expect(snapshotFailedFields()).toEqual({ reason: "store-failed" });
    expect(logs.join("\n")).not.toContain("Quillfeather");
  });

  it("logs search-failed, not the message, when gold set A's search fails other than by a refusal", async () => {
    const fake = fakeDeps({ goldSearch: () => reply("Quillfeather", 500) });
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toEqual({ taken: false, reason: "failed" });
    expect(snapshotFailedFields()).toEqual({ reason: "search-failed" });
    expect(logs.join("\n")).not.toContain("answered 500");
  });

  it("logs search-failed when gold set A's search replies with what its schema refuses", async () => {
    const fake = fakeDeps({
      goldSearch: () => reply(JSON.stringify({ hitCount: "Quillfeather" })),
    });
    const { status } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(snapshotFailedFields()).toEqual({ reason: "search-failed" });
    expect(logs.join("\n")).not.toContain("Quillfeather");
  });
});

// The fields of the run's one snapshot-failed line, past its event, level
// and run id.
function snapshotFailedFields(): Record<string, unknown> {
  const lines = logged("snapshot-failed");
  expect(lines).toHaveLength(1);
  const [line] = lines;
  expect(line?.runId).toEqual(expect.any(String));
  const rest: Record<string, unknown> = { ...line };
  for (const key of ["event", "level", "runId"]) {
    Reflect.deleteProperty(rest, key);
  }
  return rest;
}

// When a paper fails, the logs say why and how hard the run tried, so the
// reason never has to be found again by asking Europe PMC by hand (#378).
describe("a paper that fails logs why (#378)", () => {
  // A search that finds one paper, PMC0000099, which has no fixture, so
  // Europe PMC answers 503 for its full text every time.
  const unreadable = () =>
    reply(
      JSON.stringify({
        hitCount: 1,
        resultList: { result: [{ pmcid: "PMC0000099" }] },
      }),
    );

  it("logs its PMCID, the status of Europe PMC's last answer, how many tries it took, and how many requests its last try sent", async () => {
    const fake = fakeDeps({ search: unreadable });
    fake.deps.text.hasSnapshot = () => Promise.resolve(true);
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.failed).toBe(1);
    expect(logged("paper-failed")).toEqual([
      expect.objectContaining({
        pmcid: "PMC0000099",
        why: "answered",
        status: 503,
        requestsLastTry: 5,
        tries: 3,
      }),
    ]);
  });

  it("logs a paper Europe PMC has no full text for after one try", async () => {
    const fake = fakeDeps({ search: unreadable });
    fake.deps.text.hasSnapshot = () => Promise.resolve(true);
    const real = fake.deps.europePmc;
    fake.deps.europePmc = {
      search: real.search.bind(real),
      grants: real.grants.bind(real),
      sent: real.sent.bind(real),
      fullText: () =>
        Promise.reject(new EuropePmcError("Europe PMC answered 404", 404)),
    };
    await runWith(fake);
    expect(logged("paper-failed")).toEqual([
      expect.objectContaining({
        pmcid: "PMC0000099",
        why: "answered",
        status: 404,
        tries: 1,
      }),
    ]);
  });

  it("asks again for a paper whose full text times out as it is read, and logs it as a timeout (#389)", async () => {
    const fake = fakeDeps({ search: unreadable });
    fake.deps.text.hasSnapshot = () => Promise.resolve(true);
    const real = fake.deps.europePmc;
    const instant = { now: () => 0, sleep: () => Promise.resolve() };
    // Every reply's headers arrive, and its body times out as it is read.
    const stalls = europePmc({
      clock: instant,
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.error(
                  new DOMException("The operation timed out.", "TimeoutError"),
                );
              },
            }),
          ),
        ),
    });
    fake.deps.europePmc = {
      search: real.search.bind(real),
      grants: real.grants.bind(real),
      sent: () => real.sent() + stalls.sent(),
      fullText: stalls.fullText.bind(stalls),
    };
    await runWith(fake);
    expect(logged("paper-failed")).toEqual([
      expect.objectContaining({
        pmcid: "PMC0000099",
        why: "timeout",
        requestsLastTry: 5,
        tries: 3,
      }),
    ]);
  });

  it("logs a fault in the code as such, with no message", async () => {
    const fake = fakeDeps({ search: unreadable });
    fake.deps.text.hasSnapshot = () => Promise.resolve(true);
    const real = fake.deps.europePmc;
    fake.deps.europePmc = {
      search: real.search.bind(real),
      grants: real.grants.bind(real),
      sent: real.sent.bind(real),
      fullText: () => Promise.reject(new Error("Quillfeather wrote this")),
    };
    await runWith(fake);
    expect(logged("paper-failed")).toEqual([
      expect.objectContaining({ pmcid: "PMC0000099", why: "code", tries: 1 }),
    ]);
    expect(logs.join("\n")).not.toContain("Quillfeather");
  });

  it("logs a gold paper that fails in the snapshot under its own event, with its set", async () => {
    const fake = fakeDeps({
      gold: {
        goldB: {
          about: "a test's gold set B",
          papers: [{ pmcid: "PMC0000098", references: [] }],
        },
      },
    });
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toEqual({
      taken: false,
      reason: "a gold set B paper could not be read",
    });
    expect(logged("gold-paper-failed")).toEqual([
      expect.objectContaining({
        pmcid: "PMC0000098",
        set: "B",
        why: "answered",
        status: 503,
        requestsLastTry: 5,
        tries: 3,
      }),
    ]);
    // The snapshot is lost, and its line names the paper that lost it
    // (#399).
    expect(snapshotFailedFields()).toEqual({
      reason: "gold-paper-failed",
      pmcid: "PMC0000098",
      set: "B",
    });
  });
});

describe("fitness: a paper whose full text answered 500 last run is asked for once (europe-pmc.md)", () => {
  const PMCID = "PMC0000099";
  // A search that finds one paper, PMC0000099.
  const one = () =>
    reply(
      JSON.stringify({
        hitCount: 1,
        resultList: { result: [{ pmcid: PMCID }] },
      }),
    );

  // A run whose table holds PMC0000099 as an earlier run left it: failed,
  // with `last` as why, or with no reason, as a row written before #504.
  async function after(
    last: Parameters<ReturnType<typeof fakeDeps>["table"]["markFailed"]>[1],
    answer: () => Response,
  ) {
    const fake = fakeDeps({ search: one, fullText: answer });
    fake.deps.text.hasSnapshot = () => Promise.resolve(true);
    await fake.table.addFound(
      [{ pmcid: PMCID, title: "A paper" }],
      "2026-11-08T12:00:00.000Z",
      "run-2026-11-08T12:00:00.000Z",
    );
    await fake.table.markFailed(PMCID, last);
    const run = await runWith(fake);
    const asked = fake.requests.filter((url) =>
      url.pathname.endsWith(`/${PMCID}/fullTextXML`),
    ).length;
    return { fake, run, asked };
  }

  it("asks once, with no retry, and marks it failed again when that answers 500", async () => {
    const { fake, run, asked } = await after(500, () => reply("", 500));
    expect(run.status).toBe("SUCCEEDED");
    expect(asked).toBe(1);
    expect(run.result?.failed).toBe(1);
    expect(run.retryDelays(`paper-${PMCID}`)).toEqual([]);
    expect(fake.table.rows.get(PMCID)).toMatchObject({
      status: "pending",
      failures: 2,
      lastFailure: 500,
    });
    expect(logged("paper-failed")).toEqual([
      expect.objectContaining({
        pmcid: PMCID,
        why: "answered",
        status: 500,
        requestsLastTry: 1,
        tries: 1,
      }),
    ]);
  });

  it("reads it as usual when the one request answers 200", async () => {
    const { fake, run, asked } = await after(500, () =>
      reply("<article><back><ack><p>None.</p></ack></back></article>"),
    );
    expect(asked).toBe(1);
    expect(run.result?.read).toBe(1);
    expect(fake.table.rows.get(PMCID)?.status).toBe("processed");
  });

  it("marks it failed with the new reason when the one request answers otherwise", async () => {
    const { fake, asked } = await after(500, () => reply("", 503));
    expect(asked).toBe(1);
    expect(fake.table.rows.get(PMCID)).toMatchObject({ lastFailure: 503 });
  });

  it.each<[string, Parameters<typeof after>[0]]>([
    ["a 503", 503],
    ["a 502", 502],
    ["a 429", 429],
    ["a timeout", "timeout"],
    ["no reason", undefined],
  ])(
    "gives the usual tries to a paper whose row records %s",
    async (_, last) => {
      const { fake, asked } = await after(last, () => reply("", 500));
      // The client's five tries, in each of the step's three.
      expect(asked).toBe(15);
      expect(fake.table.rows.get(PMCID)).toMatchObject({ lastFailure: 500 });
    },
  );
});
