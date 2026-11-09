import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { readRepoFile, repoFiles } from "./repo.ts";

// The scheduled conformance run (#56). The conformance files read setup
// outside the repo, such as GitHub's record of the repository and the prod
// environment's branch rule, so a rename, a transfer or a changed setting
// shows up on a schedule and not only when a deploy fails.
const WORKFLOW = ".github/workflows/conformance.yml";

// text-bucket.conformance.ts needs AWS, which #50 adds to this workflow.
const needsAws = ["test/text-bucket.conformance.ts"];

const Step = z.object({
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
      permissions: z.record(z.string(), z.string()).optional(),
      "timeout-minutes": z.number().optional(),
      steps: z.array(Step),
    }),
  ),
});

const workflow = Workflow.parse(parse(readRepoFile(WORKFLOW)));
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const conformance = steps.filter((step) =>
  (step.run ?? "").startsWith("npm run conformance"),
);

describe("the scheduled conformance run", () => {
  it("runs on a schedule and on demand", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
  });

  it("runs every conformance file that needs only GitHub's token", () => {
    expect(conformance).toHaveLength(1);
    const files = (conformance[0]?.run ?? "")
      .replace(/^npm run conformance --/u, "")
      .trim()
      .split(/\s+/u)
      .sort();
    const expected = repoFiles()
      .filter((path) => path.endsWith(".conformance.ts"))
      .filter((path) => !needsAws.includes(path))
      .sort();
    expect(expected).toEqual([
      "test/environments.conformance.ts",
      "test/github-oidc.conformance.ts",
    ]);
    expect(files).toEqual(expected);
  });

  it("maps the workflow's own token into the step", () => {
    expect(conformance[0]?.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
  });

  // Checkout needs contents: read, and the repository's record needs no
  // permission. The prod environment and its branch policies need
  // actions: read.
  it("gives the token only the read permissions the files need", () => {
    expect(workflow.permissions).toEqual({
      contents: "read",
      actions: "read",
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

  it("holds no secret and no variable", () => {
    expect(readRepoFile(WORKFLOW)).not.toMatch(/\b(secrets|vars)\./u);
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
