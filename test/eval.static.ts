import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { noLive } from "../evals/check.ts";
import { INPUTS, MISSING_INPUT } from "../evals/fingerprint.ts";
import { deploy, type Step, type Workflow } from "./app.ts";
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
// The live release's fingerprint, its exit status kept rather than tested
// with `if !`, so a missing input can be told from any other failure (#90).
const fingerprintCall =
  /\w+="\$\(node evals\/fingerprint\.ts "\$live"\)" \|\| (\w+)=\$\?/u;

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

  // The private bucket is grantlink-text-<account id>, built from the
  // account the role is in, as the app stack names it (#43).
  it("reads nothing from GitHub but the eval role's ARN", () => {
    const text = readRepoFile(".github/workflows/eval.yml");
    const names = [...text.matchAll(/\b(secrets|vars)\.(\w+)/gu)].map(
      ([, kind, name]) => `${kind ?? ""}.${name ?? ""}`,
    );
    expect([...new Set(names)]).toEqual(["secrets.AWS_EVAL_ROLE_ARN"]);
  });

  it("builds the private bucket's name from the account it assumed the role in", () => {
    const assume = steps[at(/assume-role-with-web-identity/u)]?.run ?? "";
    const mask = assume.indexOf('::add-mask::$account"');
    const bucket = assume.indexOf('echo "BUCKET=grantlink-text-$account"');
    expect(mask).toBeGreaterThan(-1);
    expect(bucket).toBeGreaterThan(mask);
    expect(assume.indexOf("GITHUB_ENV", bucket)).toBeGreaterThan(bucket);
    expect(readRepoFile("scripts/eval-snapshot.sh")).not.toContain(
      "PRIVATE_BUCKET_NAME",
    );
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

// #92: a command substitution inside echo's arguments loses its exit code,
// even under `set -e`, so a failing fingerprint.ts would hand on an empty
// fingerprint. A plain assignment on its own line keeps it.
describe("computing the fingerprint", () => {
  it("fails the job when fingerprint.ts fails", () => {
    const run = named("Compute the fingerprint")?.run ?? "";
    const lines = run.split("\n").map((line) => line.trim());
    expect(lines[0]).toBe("set -euo pipefail");
    expect(lines).toContainEqual(
      expect.stringMatching(/^\w+="\$\(node evals\/fingerprint\.ts\)"$/u),
    );
    expect(run).not.toMatch(/\becho\b[^\n]*\$\(node evals\/fingerprint\.ts/u);
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
      expect(named(name)?.if, name).toMatch(
        /^steps\.cached\.outputs\.hit != 'true'/u,
      );
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
    expect(comment?.if).toMatch(/^github\.event_name == 'pull_request'/u);
    expect(comment?.run).toContain("<!-- grantlink:eval -->");
    expect(comment?.run).toContain("-X PATCH");
  });

  it("compares with nothing, and does not fail, when the live release has no fingerprint", () => {
    // A live commit from before the eval, or before an input was added,
    // has no git hash for every input, so its fingerprint cannot be read.
    const live = named("Read the live release's report")?.run ?? "";
    expect(live).toMatch(fingerprintCall);
  });

  // #90: only a missing input means the live release predates the eval.
  // Any other failure has its own reason, and its error stays in the log.
  it("says the live release predates the eval only when an input is missing", () => {
    const live = named("Read the live release's report")?.run ?? "";
    const call = fingerprintCall.exec(live);
    const status = call?.[1] ?? "";
    expect(status).not.toBe("");
    // The step runs under set -u, so the status starts at 0 for the run
    // that succeeds and never assigns it.
    const initialised = new RegExp(
      String.raw`(?:^|\n)\s*${status}=0\n\s*\w+="\$\(node evals/fingerprint\.ts`,
      "u",
    );
    const after = live.slice(call?.index ?? 0);
    const missing = new RegExp(
      String.raw`if \[ "\$${status}" -eq ${String(MISSING_INPUT)} \]; then\n.*\n\s*echo "reason=predates-eval"[^\n]*\n\s*exit 0\n`,
      "u",
    );
    const other = new RegExp(
      String.raw`elif \[ "\$${status}" -ne 0 \]; then\n.*\n\s*echo "reason=fingerprint-failed"[^\n]*\n\s*exit 0\n\s*fi\n`,
      "u",
    );
    expect(live).toMatch(initialised);
    expect(after).toMatch(missing);
    expect(after).toMatch(other);
    expect(live).not.toMatch(/fingerprint\.ts[^\n]*2>/u);
  });

  it("hands the comment the reason it has no live report to compare with", () => {
    // #88: a live release with no report must not read as no release.
    const live = named("Read the live release's report");
    expect(live?.id).toBe("live");
    const reasons = [
      ...(live?.run ?? "").matchAll(
        /echo "reason=([\w-]+)" >> "\$GITHUB_OUTPUT"/gu,
      ),
    ].map((match) => match[1]);
    expect([...new Set(reasons)].sort()).toEqual([...noLive.options].sort());
    const comment = named("Comment with CI's scores beside the live release's");
    // The default stands only for a skipped step. A step that ran and gave
    // no reason fails the comment instead of reading as no deploy.
    const skipped =
      /^\$\{\{ steps\.live\.outcome == 'skipped' && '([\w-]+)' \|\| steps\.live\.outputs\.reason \}\}$/u;
    const fallback = skipped.exec(comment?.env?.NO_LIVE ?? "")?.[1];
    expect(noLive.safeParse(fallback).success).toBe(true);
    expect(comment?.run).toContain('--no-live "$NO_LIVE"');
  });

  // A deploy.yml run whose deploy job was skipped, because the prod role
  // is not set, still concludes success, but deployed nothing (#71).
  it("takes as the live release only a run whose deploy job succeeded", () => {
    const live = named("Read the live release's report");
    expect(live?.env?.DEPLOY_JOB).toBe(deploy.jobs.deploy?.name);
    const run = live?.run ?? "";
    expect(run).toMatch(/actions\/runs\/\$\w+\/jobs/u);
    expect(run).toContain(
      'any(.jobs[]; .name == env.DEPLOY_JOB and .conclusion == "success")',
    );
    // Only a positive answer counts: an empty or odd reply is no deploy.
    expect(run).toContain('if [ "$deployed" = "true" ]');
    expect(run).not.toContain(".workflow_runs[0].head_sha");
  });

  // The comparison is advice for the comment. A failed read of GitHub's
  // runs leaves nothing to compare with; it does not fail the eval job.
  it("treats a failed read of the deploy runs as nothing to compare with", () => {
    const run = named("Read the live release's report")?.run ?? "";
    const calls = run.match(/gh api/gu) ?? [];
    const guarded = run.match(/if ! \w+="\$\(gh api/gu) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(guarded).toHaveLength(calls.length);
  });

  it("masks the account id before any line that could print it", () => {
    const assume = named("Assume the eval role")?.run ?? "";
    const mask = assume.search(/::add-mask::\$account\b/u);
    expect(mask).toBeGreaterThan(-1);
    expect(mask).toBeLessThan(assume.indexOf("GITHUB_ENV"));
  });
});

// The app stack creates the private bucket, and the deploy needs the eval,
// so the eval must not need the bucket before the first deploy.
describe("before the first deploy creates the private bucket", () => {
  it("reads a missing bucket as no report filed, and says so", () => {
    const look =
      named("Look for the report filed for this fingerprint")?.run ?? "";
    expect(look).toContain("NoSuchBucket");
    expect(look).toContain("bucket=missing");
  });

  it("files nothing and compares with nothing, but still hands its report on", () => {
    expect(named("File the report")?.if).toBe(
      "steps.cached.outputs.hit != 'true' && steps.cached.outputs.bucket != 'missing'",
    );
    expect(named("Read the live release's report")?.if).toBe(
      "github.event_name == 'pull_request' && steps.cached.outputs.bucket != 'missing'",
    );
    expect(named("Hand the report on")?.if).toBeUndefined();
  });

  it("needs a pinned snapshot from the bucket all the same", () => {
    const script = readRepoFile("scripts/eval-snapshot.sh");
    expect(script.indexOf('"$pin" = "null"')).toBeLessThan(
      script.indexOf("get-object"),
    );
  });
});
