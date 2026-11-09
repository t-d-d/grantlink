import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { INPUTS } from "../evals/fingerprint.ts";
import type { Step, Workflow } from "./app.ts";
import { readRepoFile } from "./repo.ts";

// The eval workflow (#9, #20): the report is a cache keyed by the
// fingerprint, the runner reads local files, and a report below a floor
// fails the job.
const workflow = parse(readRepoFile(".github/workflows/eval.yml")) as Workflow;
const job = workflow.jobs.eval;
const steps: Step[] = job?.steps ?? [];
const at = (pattern: RegExp) =>
  steps.findIndex((step) => pattern.test(step.run ?? ""));
const named = (name: string) => steps.find((step) => step.name === name);

describe("the eval workflow", () => {
  it("runs on every pull request, and on main when deploy.yml calls it", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "pull_request",
      "workflow_call",
    ]);
  });

  it("runs in the eval environment, through OIDC", () => {
    expect(job?.environment).toBe("eval");
    expect(job?.permissions?.["id-token"]).toBe("write");
    expect(JSON.stringify(steps)).toContain("secrets.AWS_EVAL_ROLE_ARN");
  });

  it("hands its fingerprint and report to the deploy", () => {
    expect(Object.keys(job?.outputs ?? {}).sort()).toEqual([
      "fingerprint",
      "report",
    ]);
  });

  it("is one of the fingerprint's inputs", () => {
    expect(INPUTS).toContain(".github/workflows/eval.yml");
  });
});

describe("fitness: the same inputs are evaluated once (evals.md)", () => {
  it("looks for the report under its fingerprint before it runs anything", () => {
    const look = at(/eval-reports\/\$FINGERPRINT\.json/u);
    expect(look).toBeGreaterThan(-1);
    expect(look).toBeLessThan(at(/node evals\/run\.ts/u));
  });

  it("runs, downloads and files only when no report is filed", () => {
    for (const name of [
      "Download the snapshot",
      "Run the eval",
      "File the report",
    ]) {
      expect(named(name)?.if, name).toBe("steps.cached.outputs.hit != 'true'");
    }
  });

  it("files a report only where none is, and takes the first when two race", () => {
    const file = named("File the report")?.run ?? "";
    expect(file).toContain("--if-none-match '*'");
    expect(file).toContain("PreconditionFailed");
  });
});

describe("fitness: the runner reads local files (evals.md)", () => {
  it("runs the eval with no AWS call in the same step", () => {
    const run = steps[at(/node evals\/run\.ts/u)]?.run ?? "";
    expect(run).toBe("node evals/run.ts .eval report.json");
  });

  it("leaves the snapshot out of git and Prettier", () => {
    expect(readRepoFile(".gitignore").split("\n")).toContain(".eval/");
    expect(readRepoFile(".prettierignore").split("\n")).toContain(".eval/");
  });
});

describe("the gate and the comment", () => {
  it("gates on the floors last, so the comment shows failing scores too", () => {
    const gate = at(/node evals\/check\.ts gate/u);
    expect(gate).toBe(steps.length - 1);
    expect(at(/node evals\/check\.ts comment/u)).toBeLessThan(gate);
  });

  it("comments only on a pull request, and updates its own comment", () => {
    const comment = named("Comment with CI's scores beside the live release's");
    expect(comment?.if).toBe("github.event_name == 'pull_request'");
    expect(comment?.run).toContain("<!-- grantlink:eval -->");
    expect(comment?.run).toContain("-X PATCH");
  });

  it("masks the account id before any line that could print it", () => {
    const assume = named("Assume the eval role")?.run ?? "";
    const mask = assume.search(/::add-mask::\$account\b/u);
    expect(mask).toBeGreaterThan(-1);
    expect(mask).toBeLessThan(assume.indexOf("GITHUB_ENV"));
  });
});
