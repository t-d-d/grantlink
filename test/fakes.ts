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
    addFound(papers, at) {
      for (const paper of papers) {
        if (rows.has(paper.pmcid)) continue;
        rows.set(
          paper.pmcid,
          paperRow.parse({ ...paper, status: "pending", foundAt: at }),
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
export function reply(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    body: null,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body) as unknown),
  } as unknown as Response;
}

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
    },
    site: {
      publish(files) {
        site.files = files;
        return Promise.resolve();
      },
    },
    template: () => Promise.resolve(readRepoFile("site/index.html")),
    codeVersion: "test",
    now: () => "2026-11-09T12:00:00.000Z",
  };
  return { deps, table, text, site, requests: epmc.requests };
}
