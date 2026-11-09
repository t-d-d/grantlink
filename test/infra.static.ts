import { describe, expect, it } from "vitest";
import { readRepoFile, repoFiles } from "./repo.ts";

// The repo is public, and an account id is a secret (CLAUDE.md, #15). An
// account id is twelve digits standing alone. A dot next to the digits
// counts as joined only when a digit sits past it, so a decimal is passed
// over but an id ending a sentence is still found.
const accountId = /(?<![\w+/=-]|\d\.)\d{12}(?![\w+/=-]|\.\d)/u;

describe("no file holds an account id", () => {
  // Built here so this file holds no id for the scan below to find.
  const id = "1234567890" + "12";

  it.each([`is ${id}.`, `id: ${id}`, `(${id})`])(
    "sees the id in %s",
    (text) => {
      expect(accountId.test(text)).toBe(true);
    },
  );

  it.each(["1700000000.000200", `sha512-${id}`, `0.${id}`])(
    "passes over %s",
    (text) => {
      expect(accountId.test(text)).toBe(false);
    },
  );

  it("finds none in any file in the repo", () => {
    const holding = repoFiles()
      .filter((path) => path !== "package-lock.json")
      .filter((path) => accountId.test(readRepoFile(path)));
    expect(holding).toEqual([]);
  });

  it("finds none in an ARN, the lockfile included", () => {
    const arn = /arn:aws[\w-]*:[\w-]+:[\w-]*:\d{12}:/u;
    const holding = repoFiles().filter((path) => arn.test(readRepoFile(path)));
    expect(holding).toEqual([]);
  });
});

describe("the gate lints every template", () => {
  it("runs cfn-lint over infra/ in npm run gate", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.gate).toContain("npm run cfn-lint");
    expect(pkg.scripts["cfn-lint"]).toBe("cfn-lint infra/*.cfn.yml");
  });

  it("installs cfn-lint in CI before the gate", () => {
    const gate = readRepoFile(".github/workflows/gate.yml");
    const install = gate.indexOf("pipx install cfn-lint==");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(gate.indexOf("- run: npm run gate"));
  });
});
