import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readRepoFile, repoFiles } from "./repo.ts";
import { tiers } from "./tiers.ts";

interface CompilerOptions {
  compilerOptions: Record<string, unknown>;
}

const options = (
  JSON.parse(readRepoFile("tsconfig.base.json")) as CompilerOptions
).compilerOptions;

const on = [
  "strict",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "noUnusedLocals",
  "noUnusedParameters",
];
const off = ["allowUnreachableCode", "allowUnusedLabels"];

describe("fitness: strictness stays on (code-and-tests.md)", () => {
  it.each(on)("%s is on", (name) => {
    expect(options[name]).toBe(true);
  });

  it.each(off)("%s is off", (name) => {
    expect(options[name]).toBe(false);
  });
});

const isTest = (path: string): boolean =>
  path.endsWith(".ts") &&
  path !== "vitest.config.ts" &&
  /^import [^;]* from "vitest";$/mu.test(readRepoFile(path));

const tierOf = (path: string) =>
  tiers.find((tier) => path.endsWith(tier.suffix));

describe("fitness: tests sit in their tier (code-and-tests.md)", () => {
  it("names every file that imports vitest for its tier", () => {
    const untiered = repoFiles()
      .filter(isTest)
      .filter((path) => tierOf(path) === undefined);
    expect(untiered).toEqual([]);
  });

  it("lets no test in the gate's tiers name a key", () => {
    const keys = /OPENROUTER_KEY|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/u;
    // This file names the keys to look for, so it is left out.
    const naming = repoFiles()
      .filter((path) => path !== "test/code-and-tests.static.ts")
      .filter((path) => tierOf(path)?.inGate === true)
      .filter((path) => keys.test(readRepoFile(path)));
    expect(naming).toEqual([]);
  });

  it("gives every tier in the gate the offline guard", () => {
    const config = readRepoFile("vitest.config.ts");
    expect(config).toMatch(
      /setupFiles: tier\.inGate \? \["test\/offline\.ts"\] : \[\]/u,
    );
  });

  it("runs every tier in the gate, and no other, in npm test", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const projects = [
      ...(pkg.scripts.test ?? "").matchAll(/--project (\S+)/gu),
    ].map(([, name]) => name);
    expect(projects).toEqual(
      tiers.filter((tier) => tier.inGate).map((tier) => tier.name),
    );
  });

  // Nothing in the gate reads history past HEAD: the fingerprint reads
  // HEAD's trees, and its tests build their own repositories (#185).
  it("checks out only HEAD in CI", () => {
    const gate = parse(readRepoFile(".github/workflows/gate.yml")) as {
      jobs: Record<string, { steps: { uses?: string; with?: object }[] }>;
    };
    const checkout = gate.jobs.gate?.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout).toBeDefined();
    expect(checkout?.with ?? {}).not.toHaveProperty("fetch-depth");
  });
});
