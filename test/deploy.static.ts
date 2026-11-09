import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { deploy, type Step, type Workflow } from "./app.ts";
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

  it("reads whether both deploy roles' secrets are set, in prod", () => {
    const role = jobs.role;
    expect(role?.environment).toBe("prod");
    expect(role?.outputs?.set).toBeDefined();
    const read = JSON.stringify(role?.steps);
    expect(read).toContain("secrets.AWS_DEPLOY_ROLE_ARN");
    expect(read).toContain("secrets.AWS_DEPLOY_EXECUTION_ROLE_ARN");
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
    const accountMask = assumeRun.search(/::add-mask::\$account\b/u);
    expect(accountMask).toBeGreaterThan(-1);
    // Nothing after the role is assumed runs before the mask is set.
    expect(accountMask).toBeLessThan(assumeRun.indexOf("GITHUB_ENV"));
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
    expect(deploy.concurrency).toEqual({
      group: "deploy",
      "cancel-in-progress": false,
    });
  });
});

// Governor's PR review waits for a run of `workflows.ci` at the pull
// request's head. deploy.yml runs only on main, so naming it held every
// review (#54). On main the gate runs inside deploy.yml, so no run there is
// CI, and CI messages never fire. Governor reads a red main build as a
// failed deploy instead, but only once a deploy has succeeded.
describe("governor's CI workflow", () => {
  const governor = parse(readRepoFile(".github/governor.json")) as {
    workflows?: { ci?: string };
    ciMessages?: { enabled?: boolean };
  };
  const ci = governor.workflows?.ci ?? "";

  it("reads gate.yml as the CI workflow, with CI messages on", () => {
    expect(ci).toBe(".github/workflows/gate.yml");
    expect(governor.ciMessages?.enabled).toBe(true);
  });

  it("names a workflow that runs on pull requests", () => {
    const workflow = parse(readRepoFile(ci)) as Workflow;
    expect(Object.keys(workflow.on)).toContain("pull_request");
  });
});

describe("the deploy and the run (#19)", () => {
  const all = steps("deploy");
  const at = (pattern: RegExp) =>
    all.findIndex((step) => pattern.test(step.run ?? ""));

  it("keeps the first run's time from the stack, or sets one soon after the first deploy", () => {
    const firstAt = all.findIndex((step) => step.id === "first");
    const first = all[firstAt];
    expect(first?.run).toContain("OutputKey=='FirstRunAt'");
    expect(first?.run).toMatch(/date -u -d '\+\d+ minutes'/u);
    expect(firstAt).toBeGreaterThan(-1);
    expect(firstAt).toBeLessThan(at(/\bsls deploy\b/u));
    const deployStep = all[at(/\bsls deploy\b/u)];
    expect(deployStep?.env?.FIRST_RUN_AT).toBe("${{ steps.first.outputs.at }}");
  });

  it("sets a new first run time only when the stack does not exist, and stops on any other error", () => {
    const first = all.find((step) => step.id === "first")?.run ?? "";
    expect(first).not.toMatch(/2>\/dev\/null \|\| true/u);
    expect(first).toContain("does not exist");
    expect(first).toMatch(/exit 1/u);
  });

  it("builds the page again from the last run's data, so a deploy keeps the findings", () => {
    const publish = runs("deploy");
    expect(publish).toMatch(
      /aws s3 cp "s3:\/\/\$BUCKET\/found\.json" found\.json/u,
    );
    expect(publish).toContain(
      "node src/page/build.ts found.json site/index.html",
    );
    expect(publish).toMatch(
      /aws s3 sync site\/ "s3:\/\/\$BUCKET\/" --delete --exclude found\.json/u,
    );
    expect(at(/node src\/page\/build\.ts/u)).toBeLessThanOrEqual(
      at(/aws s3 sync/u),
    );
  });
});
