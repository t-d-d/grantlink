import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fakeDeps, reply } from "../../test/fakes.ts";
import { searchPage } from "./steps.ts";

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
    const { deps, table } = fakeDeps({
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
    expect(result.found).toBe(2);
    expect([...table.rows.keys()]).toEqual(["PMC11", "PMC13"]);
    const line = logs.find((log) => log.includes('"search-page"'));
    expect(JSON.parse(line ?? "{}")).toMatchObject({ found: 2, skipped: 1 });
    expect(logs.join("\n")).not.toContain("PMC-bad-id");
    expect(logs.join("\n")).not.toContain("Skipped title");
  });
});
