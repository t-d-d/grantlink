import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CONTACT,
  CREDIT,
  NOTICE,
  TERMS,
  foreignLoads,
  loadsOf,
  textOf,
} from "./page.ts";

// Reads the deployed page after each deploy (#17). PAGE_URL is the app
// stack's PageUrl output, https://grantlink.uk/ (#44).
const { PAGE_URL } = z
  .object({ PAGE_URL: z.url({ protocol: /^https$/u }) })
  .parse(process.env);
const page = new URL(PAGE_URL);

let response: Response;
let html: string;

beforeAll(async () => {
  response = await fetch(page, { redirect: "manual" });
  html = await response.text();
});

describe("fitness: the page carries the notice and the credit (independence.md)", () => {
  it("serves the page", () => {
    expect(response.status).toBe(200);
  });

  it("carries the independence notice, the credit and the contact", () => {
    expect(textOf(html)).toMatch(NOTICE);
    expect(html).toMatch(CREDIT);
    expect(html).toMatch(TERMS);
    expect(html).toContain(`mailto:${CONTACT}`);
  });
});

describe("fitness: the page sets no cookie and loads nothing from another host (no-tracking.md)", () => {
  it("sets no cookie", () => {
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("loads nothing from another host", () => {
    expect(foreignLoads(html, page)).toEqual([]);
  });

  it("sets no cookie and loads nothing from another host in what it loads", async () => {
    const own = [...new Set(loadsOf(html))].map((url) => new URL(url, page));
    for (const url of own) {
      const loaded = await fetch(url, { redirect: "manual" });
      expect(loaded.status, url.pathname).toBe(200);
      expect(loaded.headers.getSetCookie(), url.pathname).toEqual([]);
      expect(foreignLoads(await loaded.text(), page), url.pathname).toEqual([]);
    }
  });

  it("tells the browser to load nothing from another host", () => {
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
  });
});

describe("fitness: HTTPS only (hosting.md)", () => {
  it("sends a request on plain HTTP to HTTPS", async () => {
    const plain = new URL(page);
    plain.protocol = "http:";
    const answer = await fetch(plain, { redirect: "manual" });
    expect(answer.status).toBe(301);
    expect(answer.headers.get("location")).toBe(page.href);
  });
});

describe("fitness: every release names its report (deploy-gates.md)", () => {
  it("shows the live release's go/no-go table and links to its runs", () => {
    expect(textOf(html)).toContain("How it's run");
    expect(html).toContain('class="go-no-go"');
    const runs = [
      ...html.matchAll(
        /href="(https:\/\/github\.com\/[^/"]+\/[^/"]+\/actions\/runs\/\d+)"/gu,
      ),
    ].map((match) => match[1]);
    // The deploy's run and the run that filed the report.
    expect(runs.length).toBeGreaterThanOrEqual(2);
  });
});
