import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { deploy, type Step } from "./app.ts";
import { readRepoFile } from "./repo.ts";

// The deploy workflow (#17). Only a green merge to main deploys, through
// the deploy role in the prod environment (#8). The eval gate joins it in
// #20.
const jobs = deploy.jobs;
const needs = (name: string): string[] => {
  const value = jobs[name]?.needs;
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};
const steps = (name: string): Step[] => jobs[name]?.steps ?? [];
const runs = (name: string): string =>
  steps(name)
    .map((step) => step.run ?? "")
    .join("\n");

describe("the deploy workflow", () => {
  it("runs only on a push to main", () => {
    expect(deploy.on).toEqual({ push: { branches: ["main"] } });
  });

  it("calls the gate", () => {
    expect(jobs.gate?.uses).toBe("./.github/workflows/gate.yml");
  });

  it("reads whether the deploy role's secret is set, in prod", () => {
    const role = jobs.role;
    expect(role?.environment).toBe("prod");
    expect(role?.outputs?.set).toBeDefined();
    expect(JSON.stringify(role?.steps)).toContain(
      "secrets.AWS_DEPLOY_ROLE_ARN",
    );
  });

  it("deploys only after the gate, and only once the role's secret is set", () => {
    expect(needs("deploy").sort()).toEqual(["gate", "role"]);
    expect(jobs.deploy?.if).toBe("needs.role.outputs.set == 'true'");
  });

  it("deploys in prod, through OIDC", () => {
    expect(jobs.deploy?.environment).toBe("prod");
    expect(jobs.deploy?.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(runs("deploy")).toContain("assume-role-with-web-identity");
  });

  it("masks the account id before any line that could print it", () => {
    const all = steps("deploy");
    const assume = all.findIndex((step) =>
      (step.run ?? "").includes("assume-role-with-web-identity"),
    );
    const assumeRun = all[assume]?.run ?? "";
    expect(assumeRun).toMatch(/::add-mask::.*account/iu);
    // Nothing after the role is assumed runs before the mask is set.
    expect(assumeRun.indexOf("::add-mask::")).toBeLessThan(
      assumeRun.indexOf("GITHUB_ENV"),
    );
  });

  it("names the deploy job so governor sees each deploy", () => {
    expect(jobs.deploy?.name).toMatch(/ · deployed: grantlink$/u);
    expect(deploy.env?.TICKET_LABEL_PATHS).toBe("all");
  });

  it("never rolls back: a failed deploy is fixed forward", () => {
    const text = readRepoFile(".github/workflows/deploy.yml");
    expect(text).not.toMatch(
      /sls rollback|serverless rollback|rollback-stack/u,
    );
  });

  it("reads the live page after the deploy, so a failure turns it red", () => {
    const all = steps("deploy");
    const deployAt = all.findIndex((step) =>
      /\bsls deploy\b/u.test(step.run ?? ""),
    );
    const liveAt = all.findIndex((step) =>
      (step.run ?? "").includes("npm run test:live"),
    );
    expect(deployAt).toBeGreaterThan(-1);
    expect(liveAt).toBeGreaterThan(deployAt);
    expect(JSON.stringify(all[liveAt])).not.toContain("continue-on-error");
  });

  it("runs one deploy at a time", () => {
    expect(readRepoFile(".github/workflows/deploy.yml")).toMatch(
      /concurrency:\n\s+group: deploy\n\s+cancel-in-progress: false/u,
    );
  });
});

describe("governor sees each deploy", () => {
  const governor = parse(readRepoFile(".github/governor.json")) as {
    workflows?: { ci?: string };
    ciMessages?: { enabled?: boolean };
  };

  it("reads deploy.yml as the CI workflow, with CI messages on", () => {
    expect(governor.workflows?.ci).toBe("deploy.yml");
    expect(governor.ciMessages?.enabled).toBe(true);
  });
});
