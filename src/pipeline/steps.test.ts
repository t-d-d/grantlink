import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fakeDeps, reply } from "../../test/fakes.ts";
import { SEARCH_PAGE_SIZE } from "../europepmc/client.ts";
import { recordPage, searchPage } from "./steps.ts";

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
