// Runs workflow steps that write to $GITHUB_OUTPUT or $GITHUB_ENV under
// bash, the way a runner does when a step names no shell (`bash -e {0}`),
// and checks a failing command inside the step fails the step (#111). A
// failure inside `echo "x=$(cmd)"` does not stop a script, even under
// `set -e`, so the step would succeed with an empty value. The role steps
// must fail too when the STS reply lacks a field, where `jq -r` would print
// `null` and succeed (#122).
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
const commands = ["bash", "cat", "cut", "jq"];
const found = execFileSync("bash", ["-c", `command -v ${commands.join(" ")}`], {
  encoding: "utf8",
})
  .trim()
  .split("\n");
const bash = found[0] ?? "";

// Finds a step by its id or, for a step with none, its name.
function script(workflow: Workflow, job: string, id: string): string {
  const step = workflow.jobs[job]?.steps?.find(
    (each) => each.id === id || each.name === id,
  );
  if (step?.run === undefined) throw new Error(`no step ${job}.${id}`);
  return step.run;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

// Runs the step in an empty directory, with the stubs and the system
// commands above as its whole PATH, and any extra environment the step
// reads.
function runStep(
  run: string,
  stubs: Record<string, string> = {},
  env: Record<string, string> = {},
) {
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
  const githubEnv = join(dir, "env");
  writeFileSync(githubEnv, "");
  const step = join(dir, "step.sh");
  writeFileSync(step, run);
  const result = spawnSync(bash, ["-e", step], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...env,
      PATH: bin,
      GITHUB_OUTPUT: output,
      GITHUB_ENV: githubEnv,
      HOME: dir,
    },
  });
  return {
    status: result.status,
    output: readFileSync(output, "utf8"),
    env: readFileSync(githubEnv, "utf8"),
  };
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

// #139: the live release filed its report under the fingerprint its own
// code worked out, which a pull request that changes the fingerprint's
// inputs cannot work out again. The release record on the live page holds
// that report, so the step takes it from there. Nothing but curl is
// stubbed, so a call to node, git or aws fails the step.
describe("the eval's read of the live release's report", () => {
  const run = script(evalWorkflow, "eval", "live");
  const live = { fingerprint: "f".repeat(64), rows: [{ id: "recall-a" }] };
  const record = JSON.stringify({
    commit: "c".repeat(40),
    fingerprint: "f".repeat(64),
    deployRunUrl: "https://github.com/o/r/actions/runs/1",
    report: live,
  });
  const curl = (body: string) => `cat <<'EOF'\n${body}\nEOF`;
  // Appended to the step, so the test can see what it left in live.json.
  const env = { RELEASE_URL: "https://example.test/release.json" };
  const show = `\nif [ -f live.json ]; then echo "file=$(jq -c . live.json)" >> "$GITHUB_OUTPUT"; fi`;

  it("takes the report from the release record, with no fingerprint, git or AWS call", () => {
    const { status, output } = runStep(
      `${run}${show}`,
      {
        curl: curl(record),
      },
      env,
    );
    expect(status).toBe(0);
    expect(output).toBe(`file=${JSON.stringify(live)}\n`);
  });

  it.each([
    ["the page cannot be fetched", "exit 22"],
    ["the reply is not JSON", curl("<html>")],
    ["the record holds no report", curl('{"commit":"x"}')],
    ["the record's report is not an object", curl('{"report":"x"}')],
    ["the reply holds more than one record", curl(`${record}\n${record}`)],
  ])(
    "says the page is unread, and leaves no live report, when %s",
    (_, stub) => {
      const { status, output } = runStep(`${run}${show}`, { curl: stub }, env);
      expect(status).toBe(0);
      expect(output).toBe("reason=page-unread\n");
    },
  );
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

const account = "account-placeholder";

// What STS answers, less any field a case drops. The stubs answer the
// token request and the assume-role call; every value is a placeholder.
function stsReply(drop?: string): string {
  const reply = {
    Credentials: {
      AccessKeyId: "key-placeholder",
      SecretAccessKey: "secret-placeholder",
      SessionToken: "session-placeholder",
    },
    AssumedRoleUser: {
      Arn: `arn:aws:sts::${account}:assumed-role/grantlink/run`,
    },
  };
  if (drop === "Arn") return JSON.stringify({ ...reply, AssumedRoleUser: {} });
  if (drop === "AccountId") {
    return JSON.stringify({
      ...reply,
      AssumedRoleUser: { Arn: "arn:aws:sts" },
    });
  }
  if (drop === "ArnFields") {
    return JSON.stringify({
      ...reply,
      AssumedRoleUser: { Arn: "not-an-arn" },
    });
  }
  const credentials = Object.fromEntries(
    Object.entries(reply.Credentials).filter(([key]) => key !== drop),
  );
  return JSON.stringify({ ...reply, Credentials: credentials });
}

const roleEnv = {
  ROLE: "role-placeholder",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-placeholder",
  ACTIONS_ID_TOKEN_REQUEST_URL: "http://127.0.0.1/token?x=1",
  GITHUB_RUN_ID: "1",
};

function assumeRole(run: string, reply: string) {
  return runStep(
    run,
    {
      curl: `echo '{"value":"token-placeholder"}'`,
      aws: `cat <<'EOF'\n${reply}\nEOF`,
    },
    roleEnv,
  );
}

const missingFields = [
  "AccessKeyId",
  "SecretAccessKey",
  "SessionToken",
  "Arn",
  "AccountId",
  "ArnFields",
];

describe.each([
  {
    title: "the eval's role step",
    run: script(evalWorkflow, "eval", "Assume the eval role"),
    extra: [`grantlink-text-${account}`],
  },
  {
    title: "the deploy's role step",
    run: script(deploy, "deploy", "Assume the deploy role"),
    extra: [],
  },
])("$title", ({ run, extra }) => {
  // The values only: no test in the gate names the variables that hold a
  // key (code-and-tests.md), and the static tests read the names.
  it("writes the credentials STS gave it", () => {
    const { status, env } = assumeRole(run, stsReply());
    expect(status).toBe(0);
    const values = env
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(line.indexOf("=") + 1));
    expect(values).toEqual([
      "key-placeholder",
      "secret-placeholder",
      "session-placeholder",
      ...extra,
    ]);
  });

  it.each(missingFields)("fails when the reply has no %s", (field) => {
    const { status, env } = assumeRole(run, stsReply(field));
    expect(status).not.toBe(0);
    expect(env).toBe("");
  });
});
