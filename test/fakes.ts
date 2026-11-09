import { goldA } from "../evals/gold.ts";
import { europePmc, type Clock } from "../src/europepmc/client.ts";
import type { Deps } from "../src/pipeline/steps.ts";
import type { PageFiles } from "../src/store/bucket.ts";
import { paperRow, type PaperRow, type Table } from "../src/store/table.ts";
import { fixture } from "./fixtures.ts";
import { readRepoFile } from "./repo.ts";

// Stand-ins for the stores and for Europe PMC, held in memory, for tests of
// a whole run. The table checks each row as the real one does.

export function memoryTable(): Table & { rows: Map<string, PaperRow> } {
  const rows = new Map<string, PaperRow>();
  const get = (pmcid: string) => {
    const row = rows.get(pmcid);
    if (row === undefined) throw new Error("ConditionalCheckFailed");
    return row;
  };
  return {
    rows,
    // As the real table: checks every paper before writing any, keeps what
    // a held row has, fills in what it lacks, and notes this run.
    addFound(papers, at, runId) {
      const found = papers.map((paper) =>
        paperRow.parse({
          ...paper,
          status: "pending",
          foundAt: at,
          foundByRun: runId,
        }),
      );
      for (const row of found) {
        rows.set(
          row.pmcid,
          paperRow.parse({ ...row, ...rows.get(row.pmcid), foundByRun: runId }),
        );
      }
      return Promise.resolve();
    },
    processed(pmcids) {
      return Promise.resolve(
        new Set(pmcids.filter((id) => rows.get(id)?.status === "processed")),
      );
    },
    markProcessed(pmcid, result) {
      rows.set(
        pmcid,
        paperRow.parse({ ...get(pmcid), ...result, status: "processed" }),
      );
      return Promise.resolve();
    },
    markFailed(pmcid) {
      const row = get(pmcid);
      rows.set(
        pmcid,
        paperRow.parse({ ...row, failures: (row.failures ?? 0) + 1 }),
      );
      return Promise.resolve();
    },
    all() {
      return Promise.resolve([...rows.values()]);
    },
  };
}

// A reply whose body is already in memory. The local durable runner fakes
// the clock to skip waits, and a real Response reads its body through
// streams that stall under that clock.
export function reply(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: null,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body) as unknown),
  } as unknown as Response;
}

// The papers gold set A's search finds, and the grant each is linked to.
// PMC0000003 is linked to none, so the snapshot passes it over.
const GOLD_SEARCH = { PMC0000001: true, PMC0000002: true, PMC0000003: true };
const GRANTS: Partial<Record<string, string>> = {
  PMC0000001: "A56789",
  PMC0000002: "RRCOER-Jun24\\100008",
};

// Whether a request is gold set A's sampling search. The client wraps the
// recorded query, so the request holds it rather than starts with it.
export const isGoldSearch = (url: URL) =>
  url.pathname.endsWith("/search") &&
  (url.searchParams.get("query") ?? "").includes(goldA.query);

// Europe PMC answering from the fixtures. A paper with no fixture fails as
// a server error does; `search` may be replaced to fail the search.
export function fakeEuropePmc(
  options: { search?: (cursor: string) => Response } = {},
) {
  const requests: URL[] = [];
  const instant: Clock = { now: () => 0, sleep: () => Promise.resolve() };
  const fetch = (url: URL) => {
    requests.push(url);
    if (url.pathname.endsWith("/search")) {
      const query = url.searchParams.get("query") ?? "";
      // A paper's grant links, as Europe PMC's core record holds them.
      const linked = /^PMCID:(PMC\d+)$/u.exec(query)?.[1];
      if (linked !== undefined) {
        const grant = GRANTS[linked];
        return Promise.resolve(
          reply(
            JSON.stringify({
              hitCount: 1,
              resultList: {
                result: [
                  {
                    pmcid: linked,
                    ...(grant === undefined
                      ? {}
                      : {
                          grantsList: {
                            grant: [
                              { grantId: grant, agency: "Cancer Research UK" },
                            ],
                          },
                        }),
                  },
                ],
              },
            }),
          ),
        );
      }
      // Gold set A's sampling query: papers already linked to the funder.
      if (isGoldSearch(url)) {
        return Promise.resolve(
          reply(
            JSON.stringify({
              hitCount: 3,
              resultList: {
                result: Object.keys(GOLD_SEARCH).map((pmcid) => ({ pmcid })),
              },
            }),
          ),
        );
      }
      const cursor = url.searchParams.get("cursorMark") ?? "*";
      if (options.search) return Promise.resolve(options.search(cursor));
      const file = cursor === "*" ? "search-1.json" : "search-2.json";
      return Promise.resolve(reply(fixture(file)));
    }
    const pmcid = /\/(PMC\d+)\/fullTextXML$/u.exec(url.pathname)?.[1] ?? "";
    try {
      return Promise.resolve(reply(fixture(`${pmcid}.xml`)));
    } catch {
      return Promise.resolve(reply("", 503));
    }
  };
  return { client: europePmc({ fetch, clock: instant }), requests };
}

export function fakeDeps(
  options: { search?: (cursor: string) => Response } = {},
) {
  const table = memoryTable();
  const text = new Map<string, unknown>();
  // Written once, as the bucket's policy makes every write under eval/.
  const putOnce = (key: string, body: string): string => {
    const held = text.get(key);
    if (typeof held === "string") return held;
    text.set(key, body);
    return body;
  };
  const site: { files: PageFiles | undefined } = { files: undefined };
  const epmc = fakeEuropePmc(options);
  const deps: Deps = {
    europePmc: epmc.client,
    table,
    text: {
      putFundingText(pmcid, sections) {
        text.set(`cache/${pmcid}.json`, sections);
        return Promise.resolve();
      },
      hasSnapshot(id) {
        return Promise.resolve(text.has(`eval/${id}/manifest.json`));
      },
      putSnapshotPaper(pmcid, body) {
        return Promise.resolve(putOnce(`eval/papers/${pmcid}.json`, body));
      },
      putManifest(id, body) {
        return Promise.resolve(putOnce(`eval/${id}/manifest.json`, body));
      },
    },
    site: {
      publish(files) {
        site.files = files;
        return Promise.resolve();
      },
    },
    template: () => Promise.resolve(readRepoFile("site/index.html")),
    release: () => Promise.resolve(null),
    codeVersion: "test",
    now: () => "2026-11-09T12:00:00.000Z",
  };
  return { deps, table, text, site, requests: epmc.requests };
}
