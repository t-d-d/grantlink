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
import { fakeDeps, reply } from "../../test/fakes.ts";
import { NAMES } from "../../test/fixtures.ts";
import { EuropePmcError } from "../europepmc/client.ts";
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

// A paper step whose full text Europe PMC refuses every time with `error`.
function refusingPapers(error: Error) {
  const fake = fakeDeps();
  fake.deps.europePmc = {
    search: fake.deps.europePmc.search.bind(fake.deps.europePmc),
    fullText: () => Promise.reject(error),
  };
  return fake;
}

describe("a run over the back catalogue", () => {
  it("reads every paper, records the references, and publishes the page", async () => {
    const fake = fakeDeps();
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result).toMatchObject({
      found: 4,
      read: 3,
      failed: 1,
      published: { published: true, references: 4 },
    });

    const row = fake.table.rows.get("PMC0000001");
    expect(row?.status).toBe("processed");
    expect(row?.references?.map((r) => r.normalised)).toEqual([
      "C1234/A56789",
      "CTRQQR-2021/100010",
      "A28707",
    ]);
    expect(row?.versions).toEqual({ rules: "rules-1", code: "test" });
    expect(fake.table.rows.get("PMC0000003")?.references).toEqual([]);

    const page = fake.site.files?.["index.html"] ?? "";
    expect(page).toContain("What it found");
    expect(page).toContain("RRCOER-Jun24/100008");
    expect(page).toContain("https://europepmc.org/article/PMC/PMC0000002");
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

describe("a run that fails or finds nothing leaves the page as it was", () => {
  it("publishes nothing when the search fails", async () => {
    const fake = fakeDeps({ search: () => reply("", 503) });
    const { status } = await runWith(fake);
    expect(status).toBe("FAILED");
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

  it("publishes nothing when no paper could be read", async () => {
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
    expect(
      fake.requests.some((url) =>
        (url.searchParams.get("query") ?? "").startsWith("GRANT_AGENCY:"),
      ),
    ).toBe(false);
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
