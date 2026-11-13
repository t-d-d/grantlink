import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { ASSUME_ROLE } from "./app.ts";
import { readRepoFile, repoFiles } from "./repo.ts";

// The scheduled conformance run (#56). The conformance files read setup
// outside the repo, such as GitHub's record of the repository, the prod
// environment's branch rule, the funding text bucket's settings and
// governor's wait ticket, so a rename, a transfer, a changed setting or a
// closed wait ticket shows up on a schedule and not only when a deploy
// fails.
const WORKFLOW = ".github/workflows/conformance.yml";

const Step = z.object({
  name: z.string().optional(),
  id: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.string()).optional(),
  if: z.string().optional(),
  run: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const Workflow = z.object({
  on: z.object({
    schedule: z.array(z.object({ cron: z.string().min(1) })).min(1),
    workflow_dispatch: z.null(),
  }),
  permissions: z.record(z.string(), z.string()),
  jobs: z.record(
    z.string(),
    z.object({
      environment: z.unknown().optional(),
      permissions: z.record(z.string(), z.string()).optional(),
      "timeout-minutes": z.number().optional(),
      steps: z.array(Step),
    }),
  ),
});

const text = readRepoFile(WORKFLOW);
const workflow = Workflow.parse(parse(text));
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const at = (pattern: RegExp): number =>
  steps.findIndex((step) => pattern.test(step.run ?? ""));
const conformance = steps.filter((step) =>
  (step.run ?? "").startsWith("npm run conformance"),
);
const assumedAt = steps.findIndex((step) => step.uses === ASSUME_ROLE);
const assume = steps[assumedAt];

describe("the scheduled conformance run", () => {
  it("runs on a schedule and on demand", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
  });

  // With no file list, the conformance tier runs every file, the funding
  // text bucket's check included (#50).
  it("runs every conformance file", () => {
    expect(conformance).toHaveLength(1);
    expect(conformance[0]?.run).toBe("npm run conformance");
  });

  // A rename or a transfer changes the OIDC subject, so STS refuses the
  // conformance role. The checks that need only GitHub's token must still
  // run then, since test/github-oidc.conformance.ts is the one that says why.
  it("runs the checks even when the role could not be assumed", () => {
    expect(conformance[0]?.if).toBe("${{ !cancelled() }}");
  });

  it("maps the workflow's own token into the step", () => {
    expect(conformance[0]?.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
  });

  // Checkout needs contents: read. The repository's record and the wait
  // ticket need no permission while the repository is public. If it goes
  // private, the wait ticket's read fails until this list and the
  // workflow grant issues: read. The prod environment and its branch
  // policies need actions: read. The OIDC token for the conformance role
  // needs id-token: write.
  it("gives the token only the permissions the files need", () => {
    expect(workflow.permissions).toEqual({
      contents: "read",
      actions: "read",
      "id-token": "write",
    });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toBeUndefined();
    }
  });

  // A stalled install or fetch would otherwise hold the run for GitHub's
  // six hours before it goes red. Each test already stops at 30 seconds.
  it("stops a stalled run within ten minutes", () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job["timeout-minutes"]).toBe(10);
    }
  });
});

// The conformance role trusts runs on main. A job that named an
// environment would carry that environment's subject, and be refused (#50).
describe("the run reads the funding text bucket", () => {
  it("names no environment", () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job.environment).toBeUndefined();
    }
  });

  it("reads nothing from GitHub but the conformance role's ARN", () => {
    const names = [...text.matchAll(/\b(secrets|vars)\.(\w+)/gu)].map(
      ([, kind, name]) => `${kind ?? ""}.${name ?? ""}`,
    );
    expect([...new Set(names)]).toEqual(["secrets.AWS_CONFORMANCE_ROLE_ARN"]);
    expect(assume?.with?.role).toBe("${{ secrets.AWS_CONFORMANCE_ROLE_ARN }}");
  });

  it("assumes the role before the tests run", () => {
    expect(assumedAt).toBeGreaterThan(-1);
    expect(assumedAt).toBeLessThan(at(/^npm run conformance/u));
  });

  // test/role-credentials.static.ts checks the action's masks, its shell
  // options and the bucket's name.
  it("never traces the shell", () => {
    expect(text).not.toMatch(/\bset -x\b/u);
  });
});

// Governor starts a session on a red scheduled run on the default branch.
// Its schema leaves the feature on unless `enabled` is false.
describe("a red scheduled run starts a governor session", () => {
  it("has governor's redScheduledRun on", () => {
    const config = z
      .object({
        redScheduledRun: z.object({ enabled: z.boolean().optional() }),
      })
      .parse(JSON.parse(readRepoFile(".github/governor.json")));
    expect(config.redScheduledRun.enabled).not.toBe(false);
  });
});

// The conformance files that read GitHub share one fetch, so a change to how
// the token or the proxy is handled is made once (#489).
describe("one GitHub fetch for the conformance files", () => {
  const files = repoFiles().filter((path) => path.endsWith(".conformance.ts"));

  const users = [
    "test/github-oidc.conformance.ts",
    "test/environments.conformance.ts",
    "test/governor.conformance.ts",
  ];

  it("finds the helper", () => {
    expect(repoFiles()).toContain("test/github.ts");
  });

  it.each(users)("%s reads GitHub through the helper", (path) => {
    expect(files).toContain(path);
    expect(readRepoFile(path)).toMatch(
      /^import \{ getRepo \} from "\.\/github\.ts";$/mu,
    );
  });

  it.each(files)(
    "%s reads no token and builds no request of its own",
    (path) => {
      const text = readRepoFile(path);
      expect(text).not.toMatch(/GITHUB_TOKEN/u);
      expect(text).not.toMatch(/api\.github\.com/u);
    },
  );
});
