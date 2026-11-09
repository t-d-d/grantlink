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
  };
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

  it("publishes nothing when no paper could be read", async () => {
    const fake = fakeDeps();
    fake.deps.europePmc = {
      search: fake.deps.europePmc.search.bind(fake.deps.europePmc),
      fullText: () =>
        Promise.reject(new Error("Europe PMC answered 503, after 5 tries")),
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
