// Runs two workflow steps that write to $GITHUB_OUTPUT under bash, the way
// a runner does when a step names no shell (`bash -e {0}`), and checks a
// failing command inside the step fails the step (#111). A failure inside
// `echo "x=$(cmd)"` does not stop a script, even under `set -e`, so the
// step would succeed with an empty value.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deploy, evalWorkflow, type Workflow } from "./app.ts";

// The system commands the steps and the stubs run. The step's PATH holds
// only these and the stubs, so a call nothing stubs fails instead of
// reaching AWS.
const commands = ["bash", "cat", "jq"];
const found = execFileSync("bash", ["-c", `command -v ${commands.join(" ")}`], {
  encoding: "utf8",
})
  .trim()
  .split("\n");
const bash = found[0] ?? "";

function script(workflow: Workflow, job: string, id: string): string {
  const step = workflow.jobs[job]?.steps?.find((each) => each.id === id);
  if (step?.run === undefined) throw new Error(`no step ${job}.${id}`);
  return step.run;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

// Runs the step in an empty directory, with the stubs and the system
// commands above as its whole PATH.
function runStep(run: string, stubs: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "grantlink-step-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const work = join(dir, "work");
  mkdirSync(bin);
  mkdirSync(work);
  for (const path of found) symlinkSync(path, join(bin, basename(path)));
  for (const [name, body] of Object.entries(stubs)) {
    if (commands.includes(name)) throw new Error(`${name} is not a stub`);
    writeFileSync(join(bin, name), `#!${bash}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const output = join(dir, "output");
  writeFileSync(output, "");
  const step = join(dir, "step.sh");
  writeFileSync(step, run);
  const result = spawnSync(bash, ["-e", step], {
    cwd: work,
    encoding: "utf8",
    env: { PATH: bin, GITHUB_OUTPUT: output, HOME: dir },
  });
  return { status: result.status, output: readFileSync(output, "utf8") };
}

describe("the eval's fingerprint step", () => {
  const run = script(evalWorkflow, "eval", "fingerprint");

  it("hands on what fingerprint.ts prints", () => {
    const { status, output } = runStep(run, { node: "echo abc123" });
    expect(status).toBe(0);
    expect(output).toBe("value=abc123\n");
  });

  it("fails when fingerprint.ts fails", () => {
    expect(runStep(run, { node: "exit 1" }).status).not.toBe(0);
  });
});

describe("the eval's report hand-on", () => {
  const run = script(evalWorkflow, "eval", "report");

  it("hands on the report as one line of JSON", () => {
    const { status, output } = runStep(
      `printf '{\\n "a": 1\\n}\\n' > report.json\n${run}`,
    );
    expect(status).toBe(0);
    expect(output).toBe('json={"a":1}\n');
  });

  it("fails when report.json is missing", () => {
    expect(runStep(run).status).not.toBe(0);
  });

  it("fails when report.json is empty", () => {
    expect(runStep(`: > report.json\n${run}`).status).not.toBe(0);
  });

  it("fails when report.json is not JSON", () => {
    expect(runStep(`echo 'not json' > report.json\n${run}`).status).not.toBe(0);
  });
});

describe("the deploy's stack outputs", () => {
  const run = script(deploy, "deploy", "stack");
  const outputs = (keys: string[]) =>
    JSON.stringify(
      keys.map((key) => ({ OutputKey: key, OutputValue: `${key}-value` })),
    );
  const aws = (json: string) => `cat <<'EOF'\n${json}\nEOF`;

  it("writes the bucket, the distribution and the page's address", () => {
    const { status, output } = runStep(run, {
      aws: aws(outputs(["SiteBucketName", "DistributionId", "PageUrl"])),
    });
    expect(status).toBe(0);
    expect(output).toBe(
      [
        "bucket=SiteBucketName-value",
        "distribution=DistributionId-value",
        "url=PageUrl-value",
        "",
      ].join("\n"),
    );
  });

  it.each(["SiteBucketName", "DistributionId", "PageUrl"])(
    "fails when the stack has no %s output",
    (missing) => {
      const keys = ["SiteBucketName", "DistributionId", "PageUrl"].filter(
        (key) => key !== missing,
      );
      expect(runStep(run, { aws: aws(outputs(keys)) }).status).not.toBe(0);
    },
  );
});
