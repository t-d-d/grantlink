import { describe, expect, it } from "vitest";
import {
  europePmc,
  EuropePmcError,
  HOSTS,
  INTERVAL_MS,
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
  return { client: europePmc({ fetch, clock }), requests };
}

const ok = (body = "<article/>") => new Response(body, { status: 200 });

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

  it("gives up after a few refusals, so the paper waits for the next run", async () => {
    const { client, requests } = harness(
      () => new Response("", { status: 503 }),
    );
    await expect(client.fullText("PMC1")).rejects.toThrow(/503/u);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.length).toBeLessThanOrEqual(5);
  });

  it("retries a request that fails on the network", async () => {
    const { client, requests } = harness((_, call) => {
      if (call === 0) throw new TypeError("fetch failed");
      return ok();
    });
    await client.fullText("PMC1");
    expect(requests).toHaveLength(2);
  });

  it("does not retry a paper Europe PMC has no full text for", async () => {
    const { client, requests } = harness(
      () => new Response("", { status: 404 }),
    );
    await expect(client.fullText("PMC1")).rejects.toThrow(/404/u);
    expect(requests).toHaveLength(1);
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

  it("reads only open-access papers", () => {
    expect(searchQuery()).toContain("OPEN_ACCESS:y");
  });
});

describe("searching Europe PMC", () => {
  it("asks for open-access papers since 2020 that name the funder and are linked to none of its grants", () => {
    const query = searchQuery();
    expect(query).toContain('ACK_FUND:"Cancer Research UK"');
    expect(query).toContain('ACK_FUND:"CRUK"');
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
    expect(page).toEqual({
      hitCount: 3,
      nextCursor: "AoE",
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
