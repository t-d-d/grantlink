import { describe, expect, it } from "vitest";
import { tiers } from "./tiers.ts";
import { readRepoFile, repoFiles } from "./repo.ts";

// The service reads papers only from Europe PMC's public web services, and
// one module makes those calls (#1, "Public data only").
const code = repoFiles().filter(
  (path) =>
    path.startsWith("src/") &&
    /\.[cm]?[jt]s$/u.test(path) &&
    !tiers.some((tier) => path.endsWith(tier.suffix)),
);

// The model module calls OpenRouter, under its own rules (model-calls.md).
const CALLERS = ["src/europepmc/client.ts", "src/extract/model.ts"];

describe("fitness: one module fetches papers (public-data.md)", () => {
  it("finds the code", () => {
    expect(code).toContain("src/europepmc/client.ts");
  });

  it.each(code.filter((path) => !CALLERS.includes(path)))(
    "%s makes no request of its own",
    (path) => {
      const text = readRepoFile(path);
      expect(text).not.toMatch(/\bfetch\s*\(/u);
      expect(text).not.toMatch(/from\s+"node:(?:https?|http2|net|tls)"/u);
      expect(text).not.toMatch(/from\s+"(?:axios|got|undici|node-fetch)"/u);
    },
  );

  it("names no host but Europe PMC's in the client", () => {
    const hosts = [
      ...readRepoFile("src/europepmc/client.ts").matchAll(
        /https?:\/\/([^/"'\s]+)/gu,
      ),
    ].map(([, host]) => host);
    expect(new Set(hosts)).toEqual(new Set(["www.ebi.ac.uk", "grantlink.uk"]));
  });
});
