import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
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

  it("reads whether the deploy role's secret is set, in prod", () => {
    const role = jobs.role;
    expect(role?.environment).toBe("prod");
    expect(role?.outputs?.set).toBeDefined();
    const read = JSON.stringify(role?.steps);
    expect(read).toContain("secrets.AWS_DEPLOY_ROLE_ARN");
  });

  // A job finds or builds every other value once it has assumed the role,
  // so no copy of one can go stale in GitHub (#43).
  it("reads nothing from GitHub but the deploy role's ARN", () => {
    const text = readRepoFile(".github/workflows/deploy.yml");
    const names = [...text.matchAll(/\b(secrets|vars)\.(\w+)/gu)].map(
      ([, kind, name]) => `${kind ?? ""}.${name ?? ""}`,
    );
    expect([...new Set(names)]).toEqual(["secrets.AWS_DEPLOY_ROLE_ARN"]);
  });

  it("deploys only after the gate and the eval, and only once the role's secret is set", () => {
    expect(needs("deploy").sort()).toEqual(["eval", "gate", "role"]);
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
    expect(accountMask).toBeLessThan(assumeRun.indexOf("GITHUB_OUTPUT"));
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

// Nothing in the gate reads history past HEAD: the fingerprint reads
// HEAD's trees, and its tests build their own repositories (#185).
describe("the gate's checkout", () => {
  const GateWorkflow = z.object({
    jobs: z.object({
      gate: z.object({
        steps: z.array(
          z.object({
            uses: z.string().optional(),
            with: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      }),
    }),
  });

  it("checks out only HEAD in CI", () => {
    const gate = GateWorkflow.parse(
      parse(readRepoFile(".github/workflows/gate.yml")),
    );
    const checkout = gate.jobs.gate.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout).toBeDefined();
    expect(checkout?.with ?? {}).not.toHaveProperty("fetch-depth");
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

  it("publishes the page with scripts/publish-page.sh, after the stack and before the live tier", () => {
    const publishAt = at(/^scripts\/publish-page\.sh$/u);
    expect(publishAt).toBeGreaterThan(at(/\bsls deploy\b/u));
    expect(publishAt).toBeLessThan(at(/npm run test:live/u));
    // The role's credentials are checked in test/role-credentials.static.ts.
    const env = Object.entries(all[publishAt]?.env ?? {}).filter(
      ([, value]) => !value.includes("steps.assume.outputs."),
    );
    expect(Object.fromEntries(env)).toEqual({
      BUCKET: "${{ steps.stack.outputs.bucket }}",
      DISTRIBUTION: "${{ steps.stack.outputs.distribution }}",
    });
  });

  // test/check-stack.int.ts runs the script against a stub aws (#89).
  it("checks the stack with scripts/check-stack.sh, once the role is assumed and before anything reads the stack", () => {
    const checkAt = at(/^scripts\/check-stack\.sh$/u);
    const assumeAt = at(/assume-role-with-web-identity/u);
    const firstAt = all.findIndex((step) => step.id === "first");
    expect(checkAt).toBeGreaterThan(assumeAt);
    expect(checkAt).toBeLessThan(firstAt);
    expect(checkAt).toBeLessThan(at(/\bsls deploy\b/u));
    expect(JSON.stringify(all[checkAt])).not.toContain("continue-on-error");
  });

  // test/publish-page.int.ts runs the script against a stub aws.
  it("builds the page again from the last run's data, so a deploy keeps the findings", () => {
    const script = readRepoFile("scripts/publish-page.sh");
    expect(script).toMatch(/aws s3 cp "s3:\/\/\$BUCKET\/found\.json"/u);
    expect(script).toMatch(/node "\$repo\/src\/page\/build\.ts"/u);
    expect(script).toMatch(/--exclude found\.json/u);
    expect(script).toContain('"$repo/site/release.json"');
  });
});

describe("fitness: the eval gates every deploy (deploy-gates.md)", () => {
  const all = steps("deploy");
  const at = (pattern: RegExp) =>
    all.findIndex((step) => pattern.test(step.run ?? ""));

  it("deploys only on a push to main", () => {
    expect(deploy.on).toEqual({ push: { branches: ["main"] } });
  });

  it("runs the eval workflow, and the deploy needs it", () => {
    expect(jobs.eval?.uses).toBe("./.github/workflows/eval.yml");
    // A called workflow's job reads its environment's secrets as empty
    // unless the call passes them on (#81).
    expect(jobs.eval?.secrets).toBe("inherit");
    expect(needs("deploy")).toContain("eval");
  });

  // The eval reads which commit is live from the page (#85), not from
  // deploy.yml's runs, so it needs no actions permission.
  it("lets the eval assume its role", () => {
    expect(jobs.eval?.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      "pull-requests": "write",
    });
  });

  it("checks the report is for main's own fingerprint and clears every floor, before it deploys", () => {
    const record = at(/node src\/page\/release\.ts/u);
    const check = all[record]?.run ?? "";
    expect(check).toContain("node evals/fingerprint.ts");
    expect(check).toContain("node evals/check.ts gate");
    expect(all[record]?.env?.REPORT).toBe("${{ needs.eval.outputs.report }}");
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(at(/\bsls deploy\b/u));
  });

  it("records the release with its commit, fingerprint, report and run", () => {
    const record = all[at(/node src\/page\/release\.ts/u)];
    expect(record?.run).toContain("site/release.json");
    expect(Object.keys(record?.env ?? {}).sort()).toEqual([
      "COMMIT",
      "DEPLOY_RUN_URL",
      "FINGERPRINT",
      "REPORT",
    ]);
  });
});

// The deploy role's credentials are checked with the eval and conformance
// roles' in test/role-credentials.static.ts (#349). The live tier reads the
// page as a visitor would and gets none (#259).
describe("the deploy role's credentials", () => {
  it("are not given to the step that reads the live page", () => {
    const live = steps("deploy").find((step) =>
      (step.run ?? "").includes("npm run test:live"),
    );
    expect(live?.env).toEqual({
      PAGE_URL: "${{ steps.stack.outputs.url }}",
    });
  });
});
