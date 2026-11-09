import { z } from "zod";
import { funder } from "../extract/rules.ts";
import { isPmcid } from "../shared/pmcid.ts";

// The only module that talks to Europe PMC, and the only outside service a
// run reads papers from (docs/constraints/public-data.md). It keeps to
// Europe PMC's terms (docs/constraints/europe-pmc.md): about 2 requests a
// second, a longer wait whenever Europe PMC refuses or slows a request, and
// a User-Agent that names the service.

export const HOSTS = ["www.ebi.ac.uk"];
const BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/";

export const USER_AGENT =
  "grantlink/1 (+https://grantlink.uk/; thomas.david.dickinson@gmail.com)";

// The least time between the starts of two requests.
export const INTERVAL_MS = 500;
// A request slower than this counts as Europe PMC slowing down.
const SLOW_MS = 5_000;
const MAX_INTERVAL_MS = 16_000;
// Waits after a refusal with no Retry-After: 2s, 4s, 8s, then 16s.
const FIRST_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const ATTEMPTS = 5;
// The longest the client waits within one try. A longer Retry-After ends
// the try, and the run's step waits instead, outside the Lambda invocation.
const MAX_WAIT_MS = 60_000;
const TIMEOUT_MS = 60_000;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

type Fetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface SearchPaper {
  pmcid: string;
  title: string;
  firstPublished?: string;
}

export interface SearchPage {
  hitCount: number;
  // The cursor for the next page, or null after the last.
  nextCursor: string | null;
  papers: SearchPaper[];
  // How many results carried a malformed PMCID and were left out.
  skipped: number;
}

export interface EuropePmc {
  // The run's selection by default, or gold set A's sampling query. The
  // client keeps either to open-access papers in Europe PMC.
  search(cursor: string, selection?: string): Promise<SearchPage>;
  fullText(pmcid: string): Promise<string>;
  // The funder's grant ids Europe PMC links to a paper.
  grants(pmcid: string): Promise<string[]>;
}

// Europe PMC refused or failed the request, and this client will not try
// again. `waitSeconds` is how long Europe PMC's last refusal asked callers
// to wait, if it said: the run's step waits at least that long before it
// asks again.
export class EuropePmcError extends Error {
  readonly status: number | undefined;
  readonly waitSeconds: number | undefined;

  constructor(
    message: string,
    status: number | undefined,
    waitSeconds?: number,
  ) {
    super(message);
    this.name = "EuropePmcError";
    this.status = status;
    this.waitSeconds = waitSeconds;
  }
}

const quoted = (field: string, value: string) =>
  `${field}:"${value.replace(/"/gu, "")}"`;

// Papers published since the funder's start date, whose acknowledgement or
// funding text names the funder, and which Europe PMC links to none of its
// grants. The client keeps every search to open-access papers itself.
export function searchQuery(): string {
  const names = funder.names.map((name) => quoted("ACK_FUND", name));
  return [
    `(${names.join(" OR ")})`,
    `NOT ${quoted("GRANT_AGENCY", funder.europePmcAgency)}`,
    `FIRST_PDATE:[${funder.since} TO 3000-12-31]`,
  ].join(" AND ");
}

// A paper's first publication date, as Europe PMC gives it and the table
// keeps it.
const isoDate = z.iso.date();

// Each result's PMCID and date are read as any string and checked one by
// one, so a malformed result is left out, or loses its date, and the rest
// of the page is kept.
const searchReply = z.object({
  hitCount: z.number().int().nonnegative(),
  nextCursorMark: z.string().optional(),
  resultList: z.object({
    result: z.array(
      z.object({
        pmcid: z.string().optional(),
        title: z.string().optional(),
        firstPublicationDate: z.string().optional(),
      }),
    ),
  }),
});

// Only grant ids and agencies are read. A grant's record also names the
// people who hold it, which is never kept (personal-data.md).
const grantsReply = z.object({
  resultList: z.object({
    result: z.array(
      z.object({
        grantsList: z
          .object({
            grant: z.array(
              z.object({
                grantId: z.string().optional(),
                agency: z.string().optional(),
              }),
            ),
          })
          .optional(),
      }),
    ),
  }),
});

// Every search is the caller's selection, in brackets, and the open-access
// terms (public-data.md). Europe PMC reads a bracket inside quotes or a
// range ([a TO b] or {a TO b}) as text, so this does too. A selection could
// still step out of its brackets through an unmatched bracket, an open
// quote or range, an escape, or a regular expression (/…/), whose brackets
// are also text, so any of those is refused.
function openAccessOnly(selection: string): string {
  const refuse = () =>
    new Error(
      "a search asks only for open-access papers in Europe PMC, and its selection must stay in its brackets",
    );
  let depth = 0;
  let inQuotes = false;
  let inRange = false;
  for (const char of selection) {
    if (char === "\\") throw refuse();
    if (inQuotes) inQuotes = char !== '"';
    else if (char === '"') inQuotes = true;
    else if (inRange) inRange = char !== "]" && char !== "}";
    else if (char === "[" || char === "{") inRange = true;
    else if ("]}/".includes(char)) throw refuse();
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth < 0) throw refuse();
  }
  if (depth !== 0 || inQuotes || inRange || selection.trim() === "") {
    throw refuse();
  }
  return `(${selection}) AND OPEN_ACCESS:y AND IN_EPMC:y`;
}

// A title as plain text: Europe PMC's titles may carry inline markup.
export function plainTitle(title: string): string {
  return title
    .replace(/<[^>]*>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

function retryAfter(response: Response, clock: Clock): number | undefined {
  const header = response.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - clock.now());
}

export function europePmc(
  options: { fetch?: Fetch; clock?: Clock } = {},
): EuropePmc {
  const fetch: Fetch = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? realClock;
  // When the next request may start, and the pace between requests. Both
  // belong to this client, which a run makes for itself.
  let next = 0;
  let interval = INTERVAL_MS;

  async function request(url: URL): Promise<Response> {
    if (url.protocol !== "https:" || !HOSTS.includes(url.host)) {
      throw new Error(`refusing to call ${url.host}: not Europe PMC`);
    }
    let failure = "";
    // The Retry-After of the last refusal, in ms, if it gave one.
    let lastAsked: number | undefined;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const wait = next - clock.now();
      if (wait > 0) await clock.sleep(wait);
      const started = clock.now();
      let response: Response | undefined;
      try {
        response = await fetch(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      const took = clock.now() - started;
      // Slow down while Europe PMC is slow, and come back to the usual pace
      // a step at a time once it is not.
      interval =
        took > SLOW_MS
          ? Math.min(interval * 2, MAX_INTERVAL_MS)
          : Math.max(INTERVAL_MS, interval / 2);
      next = clock.now() + interval;

      if (response?.ok) return response;
      if (response !== undefined) {
        failure = `Europe PMC answered ${String(response.status)}`;
        const refused = response.status === 429 || response.status >= 500;
        if (!refused) throw new EuropePmcError(failure, response.status);
        await response.body?.cancel();
      }
      // Refused, or failed on the way: wait as long as Europe PMC asks, or
      // longer after each try, and keep the slower pace for a while.
      const asked = response && retryAfter(response, clock);
      lastAsked = asked;
      if (asked !== undefined && asked > MAX_WAIT_MS) {
        const seconds = Math.ceil(asked / 1_000);
        throw new EuropePmcError(
          `${failure}, asked to wait ${String(seconds)}s`,
          response?.status,
          seconds,
        );
      }
      const backoff =
        asked ??
        Math.min(FIRST_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      interval = Math.min(interval * 2, MAX_INTERVAL_MS);
      next = clock.now() + Math.max(backoff, interval);
    }
    throw new EuropePmcError(
      `${failure}, after ${String(ATTEMPTS)} tries`,
      undefined,
      lastAsked === undefined ? undefined : Math.ceil(lastAsked / 1_000),
    );
  }

  return {
    async search(cursor, selection = searchQuery()) {
      const query = openAccessOnly(selection);
      const url = new URL("search", BASE);
      url.searchParams.set("query", query);
      url.searchParams.set("resultType", "lite");
      url.searchParams.set("format", "json");
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("cursorMark", cursor);
      const reply = searchReply.parse(await (await request(url)).json());
      const results = reply.resultList.result;
      // A result with no PMCID has no full text in Europe PMC, so it is
      // not a paper to read. One with a malformed PMCID is counted.
      let skipped = 0;
      const papers: SearchPaper[] = results.flatMap((result) => {
        if (result.pmcid === undefined) return [];
        if (!isPmcid(result.pmcid)) {
          skipped += 1;
          return [];
        }
        const date = isoDate.safeParse(result.firstPublicationDate);
        return [
          {
            pmcid: result.pmcid,
            title: plainTitle(result.title ?? ""),
            ...(date.success ? { firstPublished: date.data } : {}),
          },
        ];
      });
      const nextCursor =
        results.length === 0 ||
        reply.nextCursorMark === undefined ||
        reply.nextCursorMark === cursor
          ? null
          : reply.nextCursorMark;
      return { hitCount: reply.hitCount, nextCursor, papers, skipped };
    },

    async fullText(pmcid) {
      if (!isPmcid(pmcid)) throw new Error(`not a PMCID: ${pmcid}`);
      return (await request(new URL(`${pmcid}/fullTextXML`, BASE))).text();
    },

    async grants(pmcid) {
      if (!isPmcid(pmcid)) throw new Error(`not a PMCID: ${pmcid}`);
      const url = new URL("search", BASE);
      url.searchParams.set("query", `PMCID:${pmcid}`);
      url.searchParams.set("resultType", "core");
      url.searchParams.set("format", "json");
      const reply = grantsReply.parse(await (await request(url)).json());
      // Europe PMC can list one grant more than once, as for each holder.
      // Each counts once, or it would weigh twice in gold set A's recall.
      const ids = reply.resultList.result.flatMap((result) =>
        (result.grantsList?.grant ?? []).flatMap((grant) =>
          grant.agency === funder.europePmcAgency &&
          grant.grantId !== undefined &&
          grant.grantId.trim() !== ""
            ? [grant.grantId.trim()]
            : [],
        ),
      );
      return [...new Set(ids)];
    },
  };
}
