import { describe, expect, it } from "vitest";
import {
  europePmc,
  EuropePmcError,
  HOSTS,
  INTERVAL_MS,
  LARGEST_PAGE_SIZE,
  plainTitle,
  SEARCH_PAGE_SIZE,
  searchQuery,
  USER_AGENT,
  type Clock,
} from "./client.ts";

// A clock that only moves when the client sleeps or a fake request takes
// time, and a fetch that answers from a script and records each request.
function harness(
  answer: (url: URL, call: number) => Response | Promise<Response>,
  takes: (call: number) => number = () => 100,
) {
  let now = 0;
  const clock: Clock = {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
  const requests: { url: URL; at: number; headers: Headers }[] = [];
  const fetch = async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input);
    const call = requests.length;
    requests.push({ url, at: now, headers: new Headers(init?.headers) });
    now += takes(call);
    return answer(url, call);
  };
  return { client: europePmc({ fetch, clock }), requests, clock };
}

const ok = (body = "<article/>") => new Response(body, { status: 200 });

// A reply whose headers arrive but whose body fails part way, as when the
// request times out or the connection drops while it is read.
const brokenOff = (error: Error) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<arti"));
      },
      pull(controller) {
        controller.error(error);
      },
    }),
    { status: 200 },
  );
// A reply whose body has failed before anything reads it, as when the
// connection drops just after the headers arrive.
const failedBody = (status: number) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    }),
    { status },
  );
const timedOut = () =>
  new DOMException("The operation timed out.", "TimeoutError");

describe("fitness: requests are paced (europe-pmc.md)", () => {
  it("leaves at least half a second between requests, about 2 a second", async () => {
    const { client, requests } = harness(() => ok());
    for (const id of ["PMC1", "PMC2", "PMC3", "PMC4", "PMC5"]) {
      await client.fullText(id);
    }
    const gaps = requests.slice(1).map((r, i) => r.at - (requests[i]?.at ?? 0));
    expect(INTERVAL_MS).toBe(500);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(500);
    expect(Math.max(...gaps)).toBeLessThan(1000);
  });
});

describe("fitness: requests back off (europe-pmc.md)", () => {
  it("waits as long as a refusal's Retry-After asks, then tries again", async () => {
    const { client, requests } = harness((_, call) =>
      call === 0
        ? new Response("", { status: 429, headers: { "Retry-After": "7" } })
        : ok(),
    );
    await client.fullText("PMC1");
    expect(requests).toHaveLength(2);
    expect(
      (requests[1]?.at ?? 0) - (requests[0]?.at ?? 0),
    ).toBeGreaterThanOrEqual(7_000);
  });

  it("waits longer after each refusal with no Retry-After", async () => {
    const { client, requests } = harness((_, call) =>
      call < 3 ? new Response("", { status: 503 }) : ok(),
    );
    await client.fullText("PMC1");
    const gaps = requests.slice(1).map((r, i) => r.at - (requests[i]?.at ?? 0));
    expect(gaps).toHaveLength(3);
    expect(gaps[0]).toBeGreaterThanOrEqual(1_000);
    expect(gaps[1]).toBeGreaterThan(gaps[0] ?? 0);
    expect(gaps[2]).toBeGreaterThan(gaps[1] ?? 0);
  });

  it("slows its pace when Europe PMC slows, and recovers", async () => {
    const { client, requests } = harness(
      () => ok(),
      (call) => (call === 1 ? 12_000 : 100),
    );
    for (const id of ["PMC1", "PMC2", "PMC3", "PMC4", "PMC5", "PMC6"]) {
      await client.fullText(id);
    }
    const starts = requests.map((r) => r.at);
    const gapAfterSlow = (starts[2] ?? 0) - (starts[1] ?? 0) - 12_000;
    expect(gapAfterSlow).toBeGreaterThanOrEqual(1_000);
    const lastGap = (starts[5] ?? 0) - (starts[4] ?? 0);
    expect(lastGap).toBeLessThan(gapAfterSlow + 100);
  });

  it("does not sleep longer than a minute in one try, and leaves a longer wait to the run", async () => {
    const { client, requests } = harness(
      () =>
        new Response("", { status: 429, headers: { "Retry-After": "3600" } }),
    );
    const error = await client.fullText("PMC1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EuropePmcError);
    expect(error).toMatchObject({
      message: expect.stringMatching(/asked to wait 3600s/u) as unknown,
      waitSeconds: 3600,
    });
    expect(requests).toHaveLength(1);
  });

  it("keeps to a long Retry-After for its next request, and refuses it rather than sleep", async () => {
    const { client, requests, clock } = harness((_, call) =>
      call === 0
        ? new Response("", { status: 429, headers: { "Retry-After": "7200" } })
        : ok(),
    );
    await expect(client.fullText("PMC1")).rejects.toThrow(/7200s/u);
    // The next paper, a minute later, is not asked about. The client says
    // how much longer Europe PMC asked it to wait.
    await clock.sleep(60_000);
    const error = await client.fullText("PMC2").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EuropePmcError);
    expect(error).toMatchObject({ waitSeconds: 7140 });
    expect((error as Error).message).not.toMatch(/answered 4(?!29)\d\d/u);
    expect(requests).toHaveLength(1);
    // Once the wait has passed, it asks again.
    await clock.sleep(7_140_000);
    await expect(client.fullText("PMC2")).resolves.toBe("<article/>");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.at).toBeGreaterThanOrEqual(7_200_000);
  });

  it("gives up after a few refusals, so the paper waits for the next run", async () => {
    const { client, requests } = harness(
      () => new Response("", { status: 503 }),
    );
    await expect(client.fullText("PMC1")).rejects.toThrow(/503/u);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.length).toBeLessThanOrEqual(5);
  });

  it("sends one request and no more for a full text asked for once (#504)", async () => {
    const { client, requests } = harness(
      () => new Response("", { status: 500 }),
    );
    const error = await client
      .fullText("PMC1", { once: true })
      .catch((e: unknown) => e);
    expect(requests).toHaveLength(1);
    expect(error).toMatchObject({ name: "EuropePmcError", last: 500 });
  });

  it("keeps the pace after a full text asked for once (#504)", async () => {
    const { client, requests } = harness((_, call) =>
      call === 0 ? new Response("", { status: 500 }) : ok(),
    );
    await client.fullText("PMC1", { once: true }).catch(() => undefined);
    await client.fullText("PMC2");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.at).toBeGreaterThanOrEqual(2_000);
  });

  it("passes the last Retry-After on when it gives up, so the run waits that long too", async () => {
    const { client } = harness(
      () => new Response("", { status: 429, headers: { "Retry-After": "60" } }),
    );
    const error = await client.fullText("PMC1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EuropePmcError);
    expect(error).toMatchObject({ waitSeconds: 60 });
  });

  it("retries a request that fails on the network", async () => {
    const { client, requests } = harness((_, call) => {
      if (call === 0) throw new TypeError("fetch failed");
      return ok();
    });
    await client.fullText("PMC1");
    expect(requests).toHaveLength(2);
  });

  it("retries a reply whose body times out as it is read (#389)", async () => {
    const { client, requests } = harness((_, call) =>
      call === 0 ? brokenOff(timedOut()) : ok(),
    );
    await expect(client.fullText("PMC1")).resolves.toBe("<article/>");
    expect(requests).toHaveLength(2);
  });

  it("retries a reply whose body breaks off, for a search too (#389)", async () => {
    const { client, requests } = harness((_, call) =>
      call === 0
        ? brokenOff(new TypeError("terminated"))
        : Response.json({ hitCount: 0, resultList: { result: [] } }),
    );
    await expect(client.search("*")).resolves.toMatchObject({ hitCount: 0 });
    expect(requests).toHaveLength(2);
  });

  it("waits before it asks again for a body that broke off (#389)", async () => {
    const { client, requests } = harness((_, call) =>
      call === 0 ? brokenOff(new TypeError("terminated")) : ok(),
    );
    await client.fullText("PMC1");
    expect(
      (requests[1]?.at ?? 0) - (requests[0]?.at ?? 0),
    ).toBeGreaterThanOrEqual(2_000);
  });

  it("does not retry a reply it reads whole but cannot parse", async () => {
    const { client, requests } = harness(() => ok("{ not json"));
    await expect(client.search("*")).rejects.toThrow(SyntaxError);
    expect(requests).toHaveLength(1);
  });

  it("does not retry a paper Europe PMC has no full text for", async () => {
    const { client, requests } = harness(
      () => new Response("", { status: 404 }),
    );
    await expect(client.fullText("PMC1")).rejects.toThrow(/404/u);
    expect(requests).toHaveLength(1);
  });

  it("still tries again after a 503 whose body has broken off (#426)", async () => {
    const { client, requests } = harness((_url, call) =>
      call === 0 ? failedBody(503) : ok(),
    );
    await expect(client.fullText("PMC1")).resolves.toBe("<article/>");
    expect(requests).toHaveLength(2);
  });
});

describe("releasing the body of a reply it does not read", () => {
  it.each([400, 404, 410])(
    "cancels the body of a %i reply it does not retry, so its connection goes back to the pool (#426)",
    async (status) => {
      let cancelled = false;
      const { client } = harness(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
              },
            }),
            { status },
          ),
      );
      await expect(client.fullText("PMC1")).rejects.toThrow(EuropePmcError);
      expect(cancelled).toBe(true);
    },
  );

  it("still says what Europe PMC answered when the body it cancels has broken off (#426)", async () => {
    const { client } = harness(() => failedBody(404));
    await expect(client.fullText("PMC1")).rejects.toMatchObject({
      name: "EuropePmcError",
      last: 404,
    });
  });
});

describe("fitness: each request names the service (europe-pmc.md)", () => {
  it("sends a User-Agent with grantlink's name, address and contact", async () => {
    const { client, requests } = harness(() => ok());
    await client.fullText("PMC1");
    expect(USER_AGENT).toMatch(
      /^grantlink\/\S+ \(\+https:\/\/grantlink\.uk\/; .+@.+\)$/u,
    );
    expect(requests[0]?.headers.get("User-Agent")).toBe(USER_AGENT);
  });
});

describe("fitness: only Europe PMC's public web services (public-data.md)", () => {
  it("calls only Europe PMC's host, over HTTPS", async () => {
    const { client, requests } = harness((url) =>
      url.pathname.endsWith("/search")
        ? Response.json({ hitCount: 0, resultList: { result: [] } })
        : ok(),
    );
    await client.search("*");
    await client.fullText("PMC1");
    expect(HOSTS).toEqual(["www.ebi.ac.uk"]);
    for (const { url } of requests) {
      expect(url.protocol).toBe("https:");
      expect(HOSTS).toContain(url.host);
      expect(url.pathname).toMatch(/^\/europepmc\/webservices\/rest\//u);
    }
  });

  it("reads only open-access papers", async () => {
    const { client, requests } = harness(() =>
      Response.json({ hitCount: 0, resultList: { result: [] } }),
    );
    await client.search("*");
    expect(requests[0]?.url.searchParams.get("query")).toBe(
      `(${searchQuery()}) AND OPEN_ACCESS:y AND IN_EPMC:y`,
    );
  });

  it.each([
    ["negates the open-access terms", "NOT OPEN_ACCESS:y AND IN_EPMC:y"],
    ["ORs around them", "X OR (OPEN_ACCESS:y AND IN_EPMC:y)"],
  ])("keeps a query that %s to open-access papers", async (_, selection) => {
    const { client, requests } = harness(() =>
      Response.json({ hitCount: 0, resultList: { result: [] } }),
    );
    await client.search("*", selection);
    expect(requests[0]?.url.searchParams.get("query")).toBe(
      `(${selection}) AND OPEN_ACCESS:y AND IN_EPMC:y`,
    );
  });

  it.each([
    ["closes the brackets early", "X) OR (Y"],
    ["leaves a bracket open", "(X OR Y"],
    ["leaves a quote open", 'ACK_FUND:"X) OR (Y'],
    ["escapes a character", "X \\) OR \\(Y"],
    ["hides a bracket in a range", "A:[x TO y(]) OR (B:[p TO q)]"],
    ["hides a bracket in a regular expression", "A:/(/) OR (B:/)/"],
    ["leaves a range open", "A:[x TO y) OR (B"],
  ])("refuses a query that %s", async (_, part) => {
    // The open-access terms are there, so only the brackets can refuse it.
    const selection = `${part} AND OPEN_ACCESS:y AND IN_EPMC:y`;
    const { client, requests } = harness(() => ok());
    await expect(client.search("*", selection)).rejects.toThrow(/open-access/u);
    expect(requests).toHaveLength(0);
  });

  it("refuses an empty selection", async () => {
    const { client, requests } = harness(() => ok());
    await expect(client.search("*", " ")).rejects.toThrow(/open-access/u);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["quotes", 'TITLE:"a (b"'],
    ["a range", "FIRST_PDATE:[a( TO b]"],
  ])("counts a bracket inside %s as text", async (_, selection) => {
    const { client, requests } = harness(() =>
      Response.json({ hitCount: 0, resultList: { result: [] } }),
    );
    await client.search("*", selection);
    expect(requests).toHaveLength(1);
  });
});

describe("searching Europe PMC", () => {
  it("asks for papers since 2020 that name the funder and are linked to none of its grants", () => {
    const query = searchQuery();
    expect(query).toContain('ACK_FUND:"Cancer Research UK"');
    expect(query).toContain('ACK_FUND:"CRUK"');
    expect(query).toContain('ACK_FUND:"CR-UK"');
    expect(query).toContain('NOT GRANT_AGENCY:"Cancer Research UK"');
    expect(query).toContain("FIRST_PDATE:[2020-01-01 TO 3000-12-31]");
  });

  it("reads a page of results and the cursor for the next", async () => {
    const { client, requests } = harness(() =>
      Response.json({
        hitCount: 3,
        nextCursorMark: "AoE",
        resultList: {
          result: [
            {
              pmcid: "PMC11",
              title: "One <i>title</i> &amp; more",
              firstPublicationDate: "2021-02-03",
            },
            { pmcid: "PMC12", title: "Two" },
            { id: "38000000", title: "No PMCID, so no full text" },
          ],
        },
      }),
    );
    const page = await client.search("*");
    expect(requests[0]?.url.searchParams.get("cursorMark")).toBe("*");
    expect(requests[0]?.url.searchParams.get("format")).toBe("json");
    expect(requests[0]?.url.searchParams.get("pageSize")).toBe(
      String(SEARCH_PAGE_SIZE),
    );
    expect(page).toEqual({
      hitCount: 3,
      nextCursor: "AoE",
      skipped: 0,
      papers: [
        {
          pmcid: "PMC11",
          title: "One title & more",
          firstPublished: "2021-02-03",
        },
        { pmcid: "PMC12", title: "Two" },
      ],
    });
  });

  it("asks for a larger page when told to", async () => {
    const { client, requests } = harness(() =>
      Response.json({ hitCount: 0, resultList: { result: [] } }),
    );
    await client.search("*", "TITLE:x", LARGEST_PAGE_SIZE);
    expect(requests[0]?.url.searchParams.get("pageSize")).toBe("1000");
  });

  it("skips a result with a malformed PMCID and keeps the rest of the page", async () => {
    const { client } = harness(() =>
      Response.json({
        hitCount: 3,
        resultList: {
          result: [
            { pmcid: "PMC11", title: "One" },
            { pmcid: "PMC 12", title: "Malformed" },
            { pmcid: "PMC13", title: "Three" },
          ],
        },
      }),
    );
    const page = await client.search("*");
    expect(page.papers.map((paper) => paper.pmcid)).toEqual(["PMC11", "PMC13"]);
    expect(page.skipped).toBe(1);
  });

  it("keeps a page whose every PMCID is malformed as a page of no papers, and counts them", async () => {
    const { client } = harness(() =>
      Response.json({
        hitCount: 3,
        nextCursorMark: "AoE",
        resultList: {
          result: [
            { pmcid: "PMC 11", title: "Malformed" },
            { id: "38000000", title: "No PMCID, so no full text" },
            { pmcid: "pmc12", title: "Malformed too" },
          ],
        },
      }),
    );
    const page = await client.search("*");
    expect(page.papers).toEqual([]);
    expect(page.skipped).toBe(2);
    expect(page.nextCursor).toBe("AoE");
  });

  it("returns a page of results with no PMCID as an empty page", async () => {
    const { client } = harness(() =>
      Response.json({
        hitCount: 1,
        resultList: { result: [{ id: "38000000", title: "No PMCID" }] },
      }),
    );
    const page = await client.search("*");
    expect(page.papers).toEqual([]);
    expect(page.skipped).toBe(0);
  });

  it("keeps a paper whose first publication date is malformed, without a date", async () => {
    const { client } = harness(() =>
      Response.json({
        hitCount: 2,
        resultList: {
          result: [
            {
              pmcid: "PMC11",
              title: "One",
              firstPublicationDate: "03/02/2021",
            },
            {
              pmcid: "PMC12",
              title: "Two",
              firstPublicationDate: "2021-02-30",
            },
          ],
        },
      }),
    );
    const page = await client.search("*");
    expect(page.papers).toEqual([
      { pmcid: "PMC11", title: "One" },
      { pmcid: "PMC12", title: "Two" },
    ]);
    expect(page.skipped).toBe(0);
  });

  it("ends at the last page", async () => {
    const { client } = harness(() =>
      Response.json({
        hitCount: 0,
        nextCursorMark: "*",
        resultList: { result: [] },
      }),
    );
    expect((await client.search("*")).nextCursor).toBeNull();
  });

  it("refuses a reply it cannot read", async () => {
    const { client } = harness(() => Response.json({ nope: true }));
    await expect(client.search("*")).rejects.toThrow();
  });
});

describe("sampling gold set A", () => {
  const gold =
    'GRANT_AGENCY:"Cancer Research UK" AND OPEN_ACCESS:y AND IN_EPMC:y AND FIRST_PDATE:[2020-01-01 TO 2026-11-08]';

  it("searches with the query it is given, kept to open-access papers", async () => {
    const { client, requests } = harness(() =>
      Response.json({ hitCount: 0, resultList: { result: [] } }),
    );
    await client.search("*", gold);
    expect(requests[0]?.url.searchParams.get("query")).toBe(
      `(${gold}) AND OPEN_ACCESS:y AND IN_EPMC:y`,
    );
  });

  it("reads the funder's grant ids Europe PMC links to a paper, and nothing about the people who hold them", async () => {
    const { client, requests } = harness(() =>
      Response.json({
        hitCount: 1,
        resultList: {
          result: [
            {
              pmcid: "PMC11",
              grantsList: {
                grant: [
                  {
                    grantId: "C1234/A56789",
                    agency: "Cancer Research UK",
                    acronym: "CRUK",
                    pi: "Made-up Holder",
                  },
                  { grantId: "A1", agency: "Another Funder" },
                  { agency: "Cancer Research UK" },
                  { grantId: "29374", agency: "Cancer Research UK" },
                ],
              },
            },
          ],
        },
      }),
    );
    const grants = await client.grants("PMC11");
    expect(grants).toEqual(["C1234/A56789", "29374"]);
    expect(JSON.stringify(grants)).not.toContain("Made-up");
    const url = requests[0]?.url;
    expect(url?.searchParams.get("query")).toBe("PMCID:PMC11");
    expect(url?.searchParams.get("resultType")).toBe("core");
  });

  it("reads each grant id once, however often Europe PMC lists it", async () => {
    const { client } = harness(() =>
      Response.json({
        hitCount: 1,
        resultList: {
          result: [
            {
              pmcid: "PMC11",
              grantsList: {
                grant: [
                  { grantId: "A56789", agency: "Cancer Research UK" },
                  { grantId: " A56789 ", agency: "Cancer Research UK" },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(await client.grants("PMC11")).toEqual(["A56789"]);
  });

  it("reads no grants for a paper Europe PMC links to none", async () => {
    const { client } = harness(() =>
      Response.json({
        hitCount: 1,
        resultList: { result: [{ pmcid: "PMC11" }] },
      }),
    );
    expect(await client.grants("PMC11")).toEqual([]);
  });
});

describe("a title as plain text", () => {
  it("keeps a title of 500 characters whole", () => {
    const title = "€".repeat(500);
    expect(plainTitle(title)).toBe(title);
  });

  it("drops control characters, which JSON spells in six bytes", () => {
    expect(plainTitle("One\u0001 two\u001f")).toBe("One two");
  });

  it("drops half a surrogate pair, including one cut at the 500th character", () => {
    expect(plainTitle("One \ud83d")).toBe("One");
    expect(plainTitle(`${"€".repeat(499)}😀`)).toBe("€".repeat(499));
  });
});

// Why a request failed and how many the client sent, so a run can log
// them for a paper that fails (#378).
describe("what a failed request leaves", () => {
  it("keeps the status of Europe PMC's last answer when it gives up", async () => {
    const { client } = harness(() => new Response("", { status: 500 }));
    const error = await client.fullText("PMC1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EuropePmcError);
    expect(error).toMatchObject({ last: 500 });
    expect(client.sent()).toBe(5);
  });

  it("keeps the status of an answer it does not retry", async () => {
    const { client } = harness(() => new Response("", { status: 404 }));
    const error = await client.fullText("PMC1").catch((e: unknown) => e);
    expect(error).toMatchObject({ last: 404 });
    expect(client.sent()).toBe(1);
  });

  it("says when the last request could not connect", async () => {
    const { client } = harness(() => {
      throw new TypeError("fetch failed");
    });
    const error = await client.fullText("PMC1").catch((e: unknown) => e);
    expect(error).toMatchObject({ last: "connection" });
  });

  it("says when the last request timed out", async () => {
    const { client } = harness(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const error = await client.fullText("PMC1").catch((e: unknown) => e);
    expect(error).toMatchObject({ last: "timeout" });
  });

  it("says the last request timed out when a body times out on every try (#389)", async () => {
    const { client } = harness(() => brokenOff(timedOut()));
    const error = await client.fullText("PMC1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EuropePmcError);
    expect(error).toMatchObject({ last: "timeout" });
    expect(client.sent()).toBe(5);
  });

  it("says the last request could not connect when a body breaks off on every try (#389)", async () => {
    const { client } = harness(() => brokenOff(new TypeError("terminated")));
    const error = await client.fullText("PMC1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EuropePmcError);
    expect(error).toMatchObject({ last: "connection" });
  });

  it("says nothing was answered when a wait still owed stops the request", async () => {
    const { client, clock } = harness(
      () =>
        new Response("", { status: 429, headers: { "Retry-After": "7200" } }),
    );
    await client.fullText("PMC1").catch(() => undefined);
    await clock.sleep(60_000);
    const error = await client.fullText("PMC2").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EuropePmcError);
    expect((error as EuropePmcError).last).toBeUndefined();
    expect(client.sent()).toBe(1);
  });

  it("counts every request it sends, answered or not", async () => {
    const { client } = harness((_, call) =>
      call === 0 ? new Response("", { status: 503 }) : ok(),
    );
    await client.fullText("PMC1");
    await client.fullText("PMC2");
    expect(client.sent()).toBe(3);
  });
});
