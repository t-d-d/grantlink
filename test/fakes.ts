import { FLOORS } from "../evals/floors.ts";
import { europePmc, type Clock } from "../src/europepmc/client.ts";
import { release, type Release } from "../src/page/release.ts";
import type { FundingSections } from "../src/extract/rules.ts";
import type { Deps, Gold } from "../src/pipeline/steps.ts";
import type { PageFiles } from "../src/store/bucket.ts";
import {
  paperRow,
  type LastFailure,
  type PaperRow,
  type Table,
} from "../src/store/table.ts";
import { fixture } from "./fixtures.ts";
import { readRepoFile } from "./repo.ts";

// Stand-ins for the stores and for Europe PMC, held in memory, for tests of
// a whole run. The table checks each row as the real one does.

export function memoryTable(): Table & {
  rows: Map<string, PaperRow>;
  search: { latest: string | null };
} {
  const rows = new Map<string, PaperRow>();
  const search: { latest: string | null } = { latest: null };
  const get = (pmcid: string) => {
    const row = rows.get(pmcid);
    if (row === undefined) throw new Error("ConditionalCheckFailed");
    return row;
  };
  // As the real table: a run that started later sorts after.
  const later = (held: string | undefined, runId: string) =>
    held !== undefined && held > runId ? held : runId;
  return {
    rows,
    search,
    // As the real table: checks every paper before writing any, keeps what
    // a held row has, fills in what it lacks, and notes this run unless a
    // run that started later has noted its own.
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
        const held = rows.get(row.pmcid);
        rows.set(
          row.pmcid,
          paperRow.parse({
            ...row,
            ...held,
            foundByRun: later(held?.foundByRun, runId),
          }),
        );
      }
      return Promise.resolve();
    },
    recordSearch(runId) {
      search.latest = later(search.latest ?? undefined, runId);
      return Promise.resolve();
    },
    latestSearch() {
      return Promise.resolve(search.latest);
    },
    rulesRead(pmcids) {
      return Promise.resolve(
        new Map(
          pmcids.flatMap((id): [string, string | null][] => {
            const row = rows.get(id);
            return row?.status === "processed"
              ? [[id, row.versions?.rules ?? null]]
              : [];
          }),
        ),
      );
    },
    // As the real table: writes only while the rules version that read the
    // paper is still `from`, or already the result's own.
    replaceReferences(pmcid, from, result) {
      const row = rows.get(pmcid);
      const held = row?.versions?.rules ?? null;
      if (
        row?.status !== "processed" ||
        (held !== from && held !== result.versions.rules)
      ) {
        return Promise.resolve(false);
      }
      rows.set(pmcid, paperRow.parse({ ...row, ...result }));
      return Promise.resolve(true);
    },
    markProcessed(pmcid, result) {
      rows.set(
        pmcid,
        paperRow.parse({ ...get(pmcid), ...result, status: "processed" }),
      );
      return Promise.resolve();
    },
    lastFailures(pmcids) {
      return Promise.resolve(
        new Map(
          pmcids.flatMap((id): [string, LastFailure][] => {
            const row = rows.get(id);
            return row === undefined ||
              row.status === "processed" ||
              row.lastFailure === undefined
              ? []
              : [[id, row.lastFailure]];
          }),
        ),
      );
    },
    // As the real table: counts the failure, and keeps why or no reason.
    markFailed(pmcid, why) {
      const row = get(pmcid);
      rows.set(
        pmcid,
        paperRow.parse({
          ...row,
          failures: (row.failures ?? 0) + 1,
          lastFailure: why,
        }),
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

// The gold sets a test's run reads, in place of the repo's own, so a test's
// time does not grow as gold set B does. Gold set A lists no papers, so the
// snapshot samples it from its search. Gold set B is three papers neither
// search finds, so a refusal the run meets is not met again in gold set B.
export const FAKE_GOLD: Gold = {
  goldA: {
    about: "a test's gold set A",
    query: 'GRANT_AGENCY:"Test Funder"',
    seed: 7,
    size: 300,
    papers: [],
  },
  goldB: {
    about: "a test's gold set B",
    papers: ["PMC0000011", "PMC0000012", "PMC0000013"].map((pmcid) => ({
      pmcid,
      references: [],
    })),
  },
  snapshotId: "s1",
};

// Whether a request is gold set A's sampling search. The client wraps the
// recorded query, so the request holds it rather than starts with it.
export const isGoldSearch = (url: URL) =>
  url.pathname.endsWith("/search") &&
  (url.searchParams.get("query") ?? "").includes(FAKE_GOLD.goldA.query);

// How a test may replace Europe PMC's answers: `search` for the run's
// search, and `goldSearch` for gold set A's sampling search.
export interface FakeSearches {
  search?: (cursor: string) => Response;
  goldSearch?: (cursor: string) => Response;
  // Europe PMC's answer for a paper's full text, in place of its fixture.
  fullText?: (pmcid: string) => Response;
}

const LABELLED = new Set(FAKE_GOLD.goldB.papers.map((paper) => paper.pmcid));

// What fakeDeps takes: Europe PMC's answers, and any gold set to put in
// place of FAKE_GOLD's.
export interface FakeOptions extends FakeSearches {
  gold?: Partial<Gold>;
}

// Europe PMC answering from the fixtures. A paper with no fixture fails as
// a server error does; either search may be replaced to fail it.
export function fakeEuropePmc(options: FakeSearches = {}) {
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
        if (options.goldSearch) {
          const cursor = url.searchParams.get("cursorMark") ?? "*";
          return Promise.resolve(options.goldSearch(cursor));
        }
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
    if (options.fullText) return Promise.resolve(options.fullText(pmcid));
    // FAKE_GOLD's gold set B papers have no recording of their own, and
    // answer with a full text written by hand.
    const file = LABELLED.has(pmcid) ? "PMC0000003" : pmcid;
    try {
      return Promise.resolve(reply(fixture(`${file}.xml`)));
    } catch {
      return Promise.resolve(reply("", 503));
    }
  };
  return { client: europePmc({ fetch, clock: instant }), requests };
}

// A release record, deployed by GitHub Actions run `run`. A run compares
// these ids for equality only, so a test picks them to tell releases apart.
export function fakeRelease(run: number): Release {
  const rows = FLOORS.map((floor) => ({ id: floor.id, score: 1, n: 300 }));
  return release.parse({
    commit: "c".repeat(40),
    fingerprint: "f".repeat(64),
    deployRunUrl: `https://github.com/t-d-d/grantlink/actions/runs/${String(run)}`,
    report: {
      fingerprint: "f".repeat(64),
      commit: "c".repeat(40),
      runUrl: "https://github.com/t-d-d/grantlink/actions/runs/1",
      modelId: "none: rules only",
      rulesVersion: "rules-1",
      snapshot: { id: "s1", manifestSha256: "d".repeat(64) },
      createdAt: "2026-11-09T12:00:00.000Z",
      rows,
      baseline: rows,
      missedA: [],
    },
  });
}

export function fakeDeps(options: FakeOptions = {}) {
  const table = memoryTable();
  const text = new Map<string, unknown>();
  // Written once, as the bucket's policy makes every write under eval/.
  const putOnce = (key: string, body: string): string => {
    const held = text.get(key);
    if (typeof held === "string") return held;
    text.set(key, body);
    return body;
  };
  // The files a run published, and the release record the last deploy put
  // in the page's bucket, or null before one has.
  const site: { files: PageFiles | undefined; live: string | null } = {
    files: undefined,
    live: null,
  };
  const epmc = fakeEuropePmc(options);
  const deps: Deps = {
    europePmc: epmc.client,
    table,
    text: {
      putFundingText(pmcid, sections) {
        text.set(`cache/${pmcid}.json`, sections);
        return Promise.resolve();
      },
      getFundingText(pmcid) {
        const held = text.get(`cache/${pmcid}.json`);
        return Promise.resolve(
          held === undefined ? null : (held as FundingSections),
        );
      },
      hasSnapshot(id) {
        return Promise.resolve(text.has(`eval/${id}/manifest.json`));
      },
      putSnapshotPaper(id, pmcid, body) {
        return Promise.resolve(
          putOnce(`eval/${id}/papers/${pmcid}.json`, body),
        );
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
      liveRelease() {
        return Promise.resolve(site.live);
      },
    },
    template: () => Promise.resolve(readRepoFile("site/index.html")),
    release: () => Promise.resolve(null),
    codeVersion: "test",
    now: () => "2026-11-09T12:00:00.000Z",
    gold: { ...FAKE_GOLD, ...options.gold },
  };
  return { deps, table, text, site, requests: epmc.requests };
}
