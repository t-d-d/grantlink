import { describe, expect, it } from "vitest";
import { appStack } from "./app.ts";
import { resource } from "./cfn.ts";
import { foreignLoads } from "./page.ts";
import { readRepoFile, repoFiles } from "./repo.ts";

// The page sets no cookies, runs no analytics and keeps no access logs, so
// it needs no cookie banner (PRD #1, "No tracking").
const pages = repoFiles().filter((path) => path.startsWith("site/"));
const page = new URL("https://grantlink.uk/");

describe("fitness: CloudFront keeps no access logs (no-tracking.md)", () => {
  it("gives the distribution no logging", () => {
    const config = resource(appStack, "Distribution").Properties
      .DistributionConfig as Record<string, unknown>;
    expect(config.Logging).toBeUndefined();
  });

  it("declares no real-time logs or log delivery", () => {
    const types = Object.values(appStack.Resources).map((r) => r.Type);
    expect(
      types.filter(
        (type) =>
          type === "AWS::CloudFront::RealtimeLogConfig" ||
          type.startsWith("AWS::Logs::Delivery"),
      ),
    ).toEqual([]);
  });
});

describe("fitness: the page runs no script and loads nothing from another host (no-tracking.md)", () => {
  it("finds the page's files", () => {
    expect(pages).toContain("site/index.html");
  });

  it.each(pages)("%s carries no script and no cookie", (path) => {
    const text = readRepoFile(path);
    expect(text).not.toMatch(/<script\b/iu);
    expect(text).not.toMatch(/cookie/iu);
  });

  it.each(pages)("%s loads nothing from another host", (path) => {
    expect(foreignLoads(readRepoFile(path), page)).toEqual([]);
  });

  it("tells browsers to load nothing from another host, and run no script", () => {
    const policy = resource(appStack, "ResponseHeaders").Properties
      .ResponseHeadersPolicyConfig as {
      SecurityHeadersConfig: {
        ContentSecurityPolicy: {
          ContentSecurityPolicy: string;
          Override: boolean;
        };
      };
    };
    const csp = policy.SecurityHeadersConfig.ContentSecurityPolicy;
    expect(csp.Override).toBe(true);
    const directives = csp.ContentSecurityPolicy.split(";").map((d) =>
      d.trim(),
    );
    expect(directives).toContain("default-src 'none'");
    expect(directives.filter((d) => d.startsWith("script-src"))).toEqual([]);
    for (const directive of directives) {
      const sources = directive.split(/\s+/u).slice(1);
      expect(
        sources.every((source) => ["'self'", "'none'"].includes(source)),
      ).toBe(true);
    }
  });
});
