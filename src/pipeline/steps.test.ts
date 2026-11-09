import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fakeDeps, fakeRelease, reply } from "../../test/fakes.ts";
import { SEARCH_PAGE_SIZE } from "../europepmc/client.ts";
import { found } from "../page/found.ts";
import {
  checkWholeSearch,
  publish,
  readPaper,
  recordPage,
  recordSearch,
  searchPage,
} from "./steps.ts";

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

describe("reading a page of the search", () => {
  it("fails a whole search that skipped results for a malformed PMCID and found no papers", () => {
    expect(() => {
      checkWholeSearch(0, 3);
    }).toThrow(
      "the search skipped 3 results for a malformed PMCID and found no papers",
    );
    expect(() => {
      checkWholeSearch(1, 3);
    }).not.toThrow();
    expect(() => {
      checkWholeSearch(0, 0);
    }).not.toThrow();
  });

  it("logs how many results it skipped, and nothing from them", async () => {
    const { deps } = fakeDeps({
      search: () =>
        reply(
          JSON.stringify({
            hitCount: 3,
            resultList: {
              result: [
                { pmcid: "PMC11", title: "One" },
                { pmcid: "PMC-bad-id", title: "Skipped title" },
                { pmcid: "PMC13", title: "Three" },
              ],
            },
          }),
        ),
    });
    const result = await searchPage(deps, "*");
    expect(result.papers.map((paper) => paper.pmcid)).toEqual([
      "PMC11",
      "PMC13",
    ]);
    const line = logs.find((log) => log.includes('"search-page"'));
    expect(JSON.parse(line ?? "{}")).toMatchObject({ found: 2, skipped: 1 });
    expect(logs.join("\n")).not.toContain("PMC-bad-id");
    expect(logs.join("\n")).not.toContain("Skipped title");
  });

  it("only searches, and leaves the table to the next step", async () => {
    const { deps, table } = fakeDeps();
    const result = await searchPage(deps, "*");
    expect(result.papers.length).toBeGreaterThan(0);
    expect(result.nextCursor).not.toBeNull();
    expect(table.rows.size).toBe(0);
  });

  // The SDK checkpoints a step's result, and a checkpoint holds at most
  // 256 KB (CHECKPOINT_SIZE_LIMIT_BYTES in @aws/durable-execution-sdk-js),
  // less a kilobyte it keeps for its own envelope. The SDK writes the result
  // with JSON.stringify, which spells a control character or half a
  // surrogate pair in six bytes.
  it.each([
    ["three bytes each in UTF-8", "€".repeat(500)],
    ["control characters", "\u0001".repeat(600)],
    ["halves of surrogate pairs", "\ud83d".repeat(600)],
    ["a pair cut at the 500th character", `${"€".repeat(499)}😀`],
  ])(
    "returns a result that fits in a checkpoint, with titles of %s",
    async (_, title) => {
      const { deps } = fakeDeps({
        search: () =>
          reply(
            JSON.stringify({
              hitCount: 1_000_000,
              nextCursorMark: "A".repeat(200),
              resultList: {
                result: Array.from(
                  { length: SEARCH_PAGE_SIZE },
                  (_, index) => ({
                    pmcid: `PMC${String(9_000_000_000 + index)}`,
                    title,
                    firstPublicationDate: "2021-02-03",
                  }),
                ),
              },
            }),
          ),
      });
      const result = await searchPage(deps, "*");
      expect(result.papers).toHaveLength(SEARCH_PAGE_SIZE);
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
        256 * 1024 - 1024,
      );
    },
  );
});

describe("recording a page of the search", () => {
  it("adds each paper to the table and returns those not yet read", async () => {
    const { deps, table } = fakeDeps();
    await table.addFound(
      [{ pmcid: "PMC21", title: "Read" }],
      deps.now(),
      "run-1",
    );
    await table.markProcessed("PMC21", {
      references: [],
      versions: { rules: "r", code: "c" },
      processedAt: deps.now(),
      runId: "run-1",
    });
    const todo = await recordPage(
      deps,
      [
        { pmcid: "PMC21", title: "Read" },
        { pmcid: "PMC22", title: "Not read" },
      ],
      "run-2",
    );
    expect(todo).toEqual(["PMC22"]);
    expect(table.rows.get("PMC22")).toMatchObject({
      status: "pending",
      foundByRun: "run-2",
    });
    expect(table.rows.get("PMC21")).toMatchObject({
      status: "processed",
      runId: "run-1",
      foundByRun: "run-2",
    });
  });
});

describe("publishing the page", () => {
  // A run deployed by GitHub Actions run 200, with one paper read, and the
  // release record the last deploy left in the page's bucket.
  async function readOne(live: unknown) {
    const fake = fakeDeps();
    fake.deps.release = () => Promise.resolve(fakeRelease(200));
    fake.site.live = live === null ? null : JSON.stringify(live);
    await fake.deps.table.addFound(
      [{ pmcid: "PMC11", title: "One" }],
      fake.deps.now(),
      "run-1",
    );
    await fake.deps.table.markProcessed("PMC11", {
      references: [],
      versions: { rules: "rules-1", code: "test" },
      processedAt: fake.deps.now(),
      runId: "run-1",
    });
    return fake;
  }

  it("leaves the page to a newer deploy, and writes its data", async () => {
    const fake = await readOne(fakeRelease(300));
    const result = await publish(fake.deps, "run-1");
    expect(result).toMatchObject({ published: true, page: "left" });
    expect(fake.site.files?.["found.json"]).toContain("run-1");
    expect(fake.site.files?.["index.html"]).toBeUndefined();
    const line = logs.find((log) => log.includes('"page-left"'));
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      runId: "run-1",
      ownDeploy: 200,
      liveDeploy: 300,
    });
  });

  it("writes both files when its release is the live one", async () => {
    const fake = await readOne(fakeRelease(200));
    const result = await publish(fake.deps, "run-1");
    expect(result).toMatchObject({ published: true, page: "written" });
    expect(fake.site.files?.["found.json"]).toContain("run-1");
    expect(fake.site.files?.["index.html"]).toContain("What it found");
  });

  it("writes both files when neither it nor the page has a release", async () => {
    const fake = await readOne(null);
    fake.deps.release = () => Promise.resolve(null);
    const result = await publish(fake.deps, "run-1");
    expect(result).toMatchObject({ published: true, page: "written" });
    expect(fake.site.files?.["index.html"]).toContain("What it found");
  });

  // The page shows the run's own release, and only the deploy writes
  // release.json beside it, so a run writes the page only when the live
  // record names its release (#119). A deploy whose publish failed leaves
  // the page and its record to the next deploy.
  it.each([
    ["newer than the live one", fakeRelease(100)],
    ["the first, with no live record", null],
  ])("leaves the page when its release is %s", async (_, live) => {
    const fake = await readOne(live);
    const result = await publish(fake.deps, "run-1");
    expect(result).toMatchObject({ published: true, page: "left" });
    expect(fake.site.files?.["found.json"]).toContain("run-1");
    expect(fake.site.files?.["index.html"]).toBeUndefined();
  });

  it("reads a newer deploy's record tolerantly, by its deploy run alone", async () => {
    const fake = await readOne({
      deployRunUrl: "https://github.com/t-d-d/grantlink/actions/runs/300",
      aFieldFromLater: true,
    });
    expect(await publish(fake.deps, "run-1")).toMatchObject({ page: "left" });
  });

  it("leaves the page to any recorded deploy when it has no record of its own", async () => {
    const fake = await readOne(fakeRelease(100));
    fake.deps.release = () => Promise.resolve(null);
    expect(await publish(fake.deps, "run-1")).toMatchObject({ page: "left" });
    expect(fake.site.files?.["found.json"]).toBeDefined();
  });
});

describe("two runs that overlap", () => {
  // Run A starts first and is still searching when run B starts. Each
  // search returns PMC0000001, and only A's also returns PMC0000002, which
  // Europe PMC has since linked to a grant. The page that ends up published
  // must list every paper the latest complete search returned (#125).
  const A = "run-2026-11-09T10:00:00.000Z";
  const B = "run-2026-11-09T11:00:00.000Z";
  const one = { pmcid: "PMC0000001", title: "One" };
  const two = { pmcid: "PMC0000002", title: "Two" };

  async function overlap(order: "B finishes first" | "A finishes first") {
    const fake = fakeDeps();
    await recordPage(fake.deps, [two], A);
    await readPaper(fake.deps, "PMC0000002", A);
    await recordPage(fake.deps, [one], B);
    await readPaper(fake.deps, "PMC0000001", B);
    // A's later page returns PMC0000001 again, after B marked it.
    await recordPage(fake.deps, [one], A);
    const finish = async (runId: string) => {
      await recordSearch(fake.deps, runId);
      await publish(fake.deps, runId);
    };
    if (order === "B finishes first") {
      await finish(B);
      await finish(A);
    } else {
      await finish(A);
      await finish(B);
    }
    return found.parse(JSON.parse(fake.site.files?.["found.json"] ?? "{}"));
  }

  it.each(["B finishes first", "A finishes first"] as const)(
    "publishes every paper the latest search returned when %s",
    async (order) => {
      const page = await overlap(order);
      expect(page.papers.map((paper) => paper.pmcid)).toEqual(["PMC0000001"]);
      expect(page.counts.papers).toBe(1);
    },
  );
});
