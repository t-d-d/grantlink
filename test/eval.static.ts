import { describe, expect, it } from "vitest";
import { noLive } from "../evals/check.ts";
import { INPUTS } from "../evals/fingerprint.ts";
import { appStack, evalWorkflow as workflow, type Step } from "./app.ts";
import { readRepoFile } from "./repo.ts";

// The eval workflow (#9, #20): the report is a cache keyed by the
// fingerprint, the runner reads local files, and a report below a floor
// fails the job.
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

  // The private bucket is grantlink-text-<account id>, built from the
  // account the role is in, as the app stack names it (#43).
  // Besides the role, the eval reads one secret: its own model key, with
  // its own credit limit (#328). The key's name is left unwritten here, as
  // no test in the gate names a key (code-and-tests.md).
  const secretNames = (text: string): string[] => [
    ...new Set(
      [...text.matchAll(/\b(secrets|vars)\.(\w+)/gu)].map(
        ([, kind, name]) => `${kind ?? ""}.${name ?? ""}`,
      ),
    ),
  ];
  const ROLE = "secrets.AWS_EVAL_ROLE_ARN";

  it("reads nothing from GitHub but the eval role's ARN and one model key", () => {
    const names = secretNames(readRepoFile(".github/workflows/eval.yml"));
    expect(names).toContain(ROLE);
    const others = names.filter((name) => name !== ROLE);
    expect(others).toHaveLength(1);
    // The key is a secret, never a repository variable.
    expect(others.every((name) => name.startsWith("secrets."))).toBe(true);
  });

  it("gives the model key to the eval's run alone, as an environment variable", () => {
    const holders = steps.filter((step) =>
      secretNames(JSON.stringify(step)).some((name) => name !== ROLE),
    );
    expect(holders.map((step) => step.name)).toEqual(["Run the eval"]);
    const run = named("Run the eval");
    expect(run?.run ?? "").not.toMatch(/secrets\./u);
    const fromSecrets = Object.entries(run?.env ?? {}).filter(([, value]) =>
      value.includes("secrets."),
    );
    expect(fromSecrets).toHaveLength(1);
  });

  it("builds the private bucket's name from the account it assumed the role in", () => {
    const assume = steps[at(/assume-role-with-web-identity/u)]?.run ?? "";
    const mask = assume.indexOf('::add-mask::$account"');
    const bucket = assume.indexOf('echo "bucket=grantlink-text-$account"');
    expect(mask).toBeGreaterThan(-1);
    expect(bucket).toBeGreaterThan(mask);
    expect(assume.indexOf("GITHUB_OUTPUT", bucket)).toBeGreaterThan(bucket);
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
    const assigned = lines
      .map(
        (line) =>
          /^(\w+)="\$\(node evals\/fingerprint\.ts\)"$/u.exec(line)?.[1],
      )
      .find((name) => name !== undefined);
    expect(assigned).toBeDefined();
    // The output is the variable the script's value went into, so the
    // fingerprint handed on is the one whose exit code was checked.
    expect(lines).toContain(
      `echo "value=$${assigned ?? ""}" >> "$GITHUB_OUTPUT"`,
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

  // #139: the live release filed its report under the fingerprint its own
  // code worked out. A pull request that changes the fingerprint's inputs
  // works out another, so the step takes the report the release record
  // holds instead of looking one up.
  it("takes the live report from the release record, not from the live commit's fingerprint", () => {
    const live = named("Read the live release's report")?.run ?? "";
    // Slurped, so a reply of several records is not taken as one.
    expect(live).toMatch(
      /jq -ces 'select\(length == 1\) \| \.\[0\]\.report \| objects'/u,
    );
    expect(live).not.toContain("fingerprint.ts");
    expect(live).not.toMatch(/\bgit\b/u);
    expect(live).not.toMatch(/\baws\b/u);
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
    const comment = named("Comment with CI's scores beside the live release's");
    // The default stands only for a skipped step. A step that ran and gave
    // no reason fails the comment instead of reading as no deploy.
    const skipped =
      /^\$\{\{ steps\.live\.outcome == 'skipped' && '([\w-]+)' \|\| steps\.live\.outputs\.reason \}\}$/u;
    const fallback = skipped.exec(comment?.env?.NO_LIVE ?? "")?.[1];
    expect(fallback).toBe("no-deploy");
    // The step skips only before the first deploy creates the private
    // bucket. Once it runs, the release record says which release is live.
    expect(reasons).not.toContain("no-deploy");
    expect([...new Set([...reasons, fallback])].sort()).toEqual(
      [...noLive.options].sort(),
    );
    expect(comment?.run).toContain('--no-live "$NO_LIVE"');
  });

  // A release is live once its page is published, whatever the deploy's
  // later steps do. The deploy writes the release record, and publishes it
  // beside the page, so the commit in it is the live release (#85).
  it("takes the live release from the release record on the live page", () => {
    const live = named("Read the live release's report");
    const domain = appStack.Parameters?.DomainName?.Default;
    expect(domain).toBe("grantlink.uk");
    expect(live?.env?.RELEASE_URL).toBe(
      `https://${String(domain)}/release.json`,
    );
    const run = live?.run ?? "";
    expect(run).toMatch(/curl [^\n]*"\$RELEASE_URL"/u);
    expect(run).not.toContain("deploy.yml/runs");
    expect(run).not.toContain("gh api");
    expect(live?.env?.GH_TOKEN).toBeUndefined();
  });

  it("does not read the deploy's run history, so needs no actions permission", () => {
    expect(job?.permissions?.actions).toBeUndefined();
  });

  // The comparison is advice for the comment. A failed read of the live
  // page leaves nothing to compare with; it does not fail the eval job.
  it("treats a failed read of the live page as nothing to compare with", () => {
    const run = named("Read the live release's report")?.run ?? "";
    const calls = run.match(/\bcurl\b/gu) ?? [];
    const guarded = run.match(/if ! \w+="\$\(curl\b/gu) ?? [];
    expect(calls).toHaveLength(1);
    expect(guarded).toHaveLength(1);
    expect(run).toContain('echo "reason=page-unread" >> "$GITHUB_OUTPUT"');
  });

  it("masks the account id before any line that could print it", () => {
    const assume = named("Assume the eval role")?.run ?? "";
    const mask = assume.search(/::add-mask::\$account\b/u);
    expect(mask).toBeGreaterThan(-1);
    expect(mask).toBeLessThan(assume.indexOf("GITHUB_OUTPUT"));
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
