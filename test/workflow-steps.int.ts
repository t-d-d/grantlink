// Runs workflow steps that write to $GITHUB_OUTPUT or $GITHUB_ENV under
// bash, the way a runner does when a step names no shell (`bash -e {0}`),
// and checks a failing command inside the step fails the step (#111). A
// failure inside `echo "x=$(cmd)"` does not stop a script, even under
// `set -e`, so the step would succeed with an empty value. The role steps
// must fail too when the STS reply lacks a field, where `jq -r` would print
// `null` and succeed (#122). All three role steps are covered (#188). The
// eval and conformance role steps stop before the network when their
// secret is unset (#250). Each role step hands its credentials on as step
// outputs, so only the steps that call AWS hold them (#259, #308).
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
import { MARKER as marker } from "../evals/check.ts";
import {
  conformanceWorkflow,
  deploy,
  evalWorkflow,
  type Workflow,
} from "./app.ts";

// The system commands the steps and the stubs run. The step's PATH holds
// only these and the stubs, so a call nothing stubs fails instead of
// reaching AWS.
const commands = ["bash", "cat", "cut", "head", "jq"];
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
// reads. $RUNNER_TEMP is a directory outside the working tree, as on a
// runner. A setup script runs in the working tree before the step, so a
// case can put files there as a pull request's tree would.
function runStep(
  run: string,
  stubs: Record<string, string> = {},
  env: Record<string, string> = {},
  setup = "",
) {
  const dir = mkdtempSync(join(tmpdir(), "grantlink-step-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const work = join(dir, "work");
  const temp = join(dir, "temp");
  mkdirSync(bin);
  mkdirSync(work);
  mkdirSync(temp);
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
  writeFileSync(step, `${setup}\n${run}`);
  const result = spawnSync(bash, ["-e", step], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...env,
      PATH: bin,
      GITHUB_OUTPUT: output,
      GITHUB_ENV: githubEnv,
      RUNNER_TEMP: temp,
      HOME: dir,
    },
  });
  return {
    temp,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
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
  // #233: the report goes outside the working tree, so a live.json in the
  // pull request's tree is never taken for it.
  const show = `\nif [ -f "$RUNNER_TEMP/live.json" ]; then echo "file=$(jq -c . "$RUNNER_TEMP/live.json")" >> "$GITHUB_OUTPUT"; fi`;

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

// #233: a pull request's tree can hold a live.json. The comment compares
// with a live report only when the live step read one, and otherwise gives
// the live step's reason. The node stub records its arguments and, like
// check.ts, reads the live report it is given, and the gh stub finds no
// earlier comment.
describe("the eval's comment", () => {
  const run = script(
    evalWorkflow,
    "eval",
    "Comment with CI's scores beside the live release's",
  );
  const live = script(evalWorkflow, "eval", "live");
  const stubs = {
    node: 'echo "$*" >> "$RUNNER_TEMP/node-args"\n[ "$4" = --no-live ] || cat "$4" > /dev/null',
    gh: ":",
    curl: `cat <<'EOF'\n${JSON.stringify({ report: { fingerprint: "live" } })}\nEOF`,
  };
  const inTree = `echo '{"fingerprint":"from-the-tree"}' > live.json`;
  const args = (temp: string) =>
    readFileSync(join(temp, "node-args"), "utf8").trim();

  it.each(["page-unread", "no-deploy"])(
    "ignores a live.json in the tree, and gives the reason, when it is %s",
    (reason) => {
      const { status, temp } = runStep(
        run,
        stubs,
        { PR: "1", GITHUB_REPOSITORY: "o/r", NO_LIVE: reason },
        inTree,
      );
      expect(status).toBe(0);
      expect(args(temp)).toBe(
        `evals/check.ts comment report.json --no-live ${reason}`,
      );
    },
  );

  // The live step runs first, so a change to where it writes the report
  // fails here rather than on every pull request.
  it("compares with the report the live step wrote, not the tree's", () => {
    const { status, temp } = runStep(
      run,
      stubs,
      {
        PR: "1",
        GITHUB_REPOSITORY: "o/r",
        NO_LIVE: "",
        RELEASE_URL: "https://example.test/release.json",
      },
      `${inTree}\n${live}`,
    );
    expect(status).toBe(0);
    expect(args(temp)).toBe(
      `evals/check.ts comment report.json ${join(temp, "live.json")}`,
    );
  });

  it("fails when the live step gave no reason and wrote no report", () => {
    const { status } = runStep(
      run,
      stubs,
      { PR: "1", GITHUB_REPOSITORY: "o/r", NO_LIVE: "" },
      inTree,
    );
    expect(status).not.toBe(0);
  });

  // #257: the step took the first marker comment's id through `head -n 1`
  // under pipefail. When head stopped reading while gh still wrote, gh died
  // of SIGPIPE and the step failed. The stub prints far more ids than a
  // pipe holds, only for a paginated read, and records the PATCH it is sent.
  it("succeeds and updates the first of many earlier comments", () => {
    const gh = [
      'if [ "$2" = -X ]; then echo "$*" >> "$RUNNER_TEMP/gh-args"; exit 0; fi',
      '[ "$2" = --paginate ] || exit 9',
      'for ((i = 101; i < 30101; i++)); do echo "$i"; done',
    ].join("\n");
    const { status, stderr, temp } = runStep(
      run,
      { ...stubs, gh },
      { PR: "1", GITHUB_REPOSITORY: "o/r", NO_LIVE: "no-deploy" },
    );
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(readFileSync(join(temp, "gh-args"), "utf8")).toBe(
      "api -X PATCH repos/o/r/issues/comments/101 -F body=@comment.md\n",
    );
  });

  // #298: anyone can comment on a public pull request. A comment from
  // another user that starts with the marker was taken as the eval's own,
  // and the PATCH to it was refused. This stub answers a paginated read
  // with the comments below, run through the step's own --jq filter by
  // jq, and records every write it is sent.
  describe("with a marker comment from another user", () => {
    const comment = (id: number, login: string, body: string) => ({
      id,
      user: { login },
      body,
    });
    const gh = (comments: unknown[]) =>
      [
        'if [ "$2" = -X ] || [ "$#" -le 4 ]; then echo "$*" >> "$RUNNER_TEMP/gh-args"; exit 0; fi',
        '[ "$2" = --paginate ] && [ "$4" = --jq ] || exit 9',
        `jq -r "$5" <<'EOF'\n${JSON.stringify(comments)}\nEOF`,
      ].join("\n");
    const written = (comments: unknown[]) => {
      const { status, stderr, temp } = runStep(
        run,
        { ...stubs, gh: gh(comments) },
        { PR: "1", GITHUB_REPOSITORY: "o/r", NO_LIVE: "no-deploy" },
      );
      expect(stderr).toBe("");
      expect(status).toBe(0);
      return readFileSync(join(temp, "gh-args"), "utf8");
    };

    it("updates the bot's comment, not the other user's", () => {
      expect(
        written([
          comment(101, "someone", `${marker}\nnot the eval's`),
          comment(102, "github-actions[bot]", `${marker}\nscores`),
        ]),
      ).toBe(
        "api -X PATCH repos/o/r/issues/comments/102 -F body=@comment.md\n",
      );
    });

    it("posts a new comment when the bot has none", () => {
      expect(
        written([comment(101, "someone", `${marker}\nnot the eval's`)]),
      ).toBe("api repos/o/r/issues/1/comments -F body=@comment.md\n");
    });
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

const account = "account-placeholder";

// What STS answers, less any field a case drops or blanks. The stubs
// answer the token request and the assume-role call; every value is a
// placeholder.
function stsReply(drop?: string, blank?: string): string {
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
  if (blank === "Arn") {
    return JSON.stringify({ ...reply, AssumedRoleUser: { Arn: "" } });
  }
  if (blank !== undefined) {
    return JSON.stringify({
      ...reply,
      Credentials: { ...reply.Credentials, [blank]: "" },
    });
  }
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

// The aws stub says on stderr that it ran, so a case can see whether the
// step reached STS.
function assumeRole(
  run: string,
  reply: string,
  oidc = '{"value":"token-placeholder"}',
) {
  return runStep(
    run,
    {
      curl: `cat <<'EOF'\n${oidc}\nEOF`,
      aws: `echo aws-called >&2\ncat <<'EOF'\n${reply}\nEOF`,
    },
    roleEnv,
  );
}

// Where each field sits in the STS reply, as the step's error names it.
const fieldPaths: Record<string, string> = {
  AccessKeyId: ".Credentials.AccessKeyId",
  SecretAccessKey: ".Credentials.SecretAccessKey",
  SessionToken: ".Credentials.SessionToken",
  Arn: ".AssumedRoleUser.Arn",
};

// The error names the path, so its dots must match only dots.
function namesPath(path: string): RegExp {
  return new RegExp(`^::error::.*${path.replaceAll(".", "\\.")}\\b`, "mu");
}

const missingFields = [...Object.keys(fieldPaths), "AccountId", "ArnFields"];

const evalRole = script(evalWorkflow, "eval", "Assume the eval role");
const conformanceRole = script(
  conformanceWorkflow,
  "conformance",
  "Assume the conformance role",
);

describe.each([
  {
    title: "the eval's role step",
    run: evalRole,
    extra: [`grantlink-text-${account}`],
  },
  {
    title: "the deploy's role step",
    run: script(deploy, "deploy", "Assume the deploy role"),
    extra: [],
  },
  // #188: the third copy of the step, which had neither fix.
  {
    title: "the conformance run's role step",
    run: conformanceRole,
    extra: [`grantlink-text-${account}`],
  },
] as const)("$title", ({ run, extra }) => {
  // Each step writes the credentials to its outputs, and nothing to
  // $GITHUB_ENV, where every later step would hold them (#259, #308).

  // The values only: no test in the gate names the variables that hold a
  // key (code-and-tests.md), and the static tests read the names.
  it("writes the credentials STS gave it", () => {
    const result = assumeRole(run, stsReply());
    expect(result.status).toBe(0);
    expect(result.env).toBe("");
    const values = result.output
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
    const result = assumeRole(run, stsReply(field));
    expect(result.status).not.toBe(0);
    expect(result.output).toBe("");
    expect(result.env).toBe("");
  });

  // #160: jq -e fails on a missing field, but says nothing on its own.
  it.each(Object.entries(fieldPaths))(
    "names %s in an error when the reply has none",
    (field, path) => {
      const { status, stderr } = assumeRole(run, stsReply(field));
      expect(status).not.toBe(0);
      expect(stderr).toMatch(namesPath(path));
    },
  );

  // #160: jq -e passes an empty string, which the step wrote on as a
  // credential.
  it.each(Object.entries(fieldPaths))(
    "fails, naming %s, when the reply's is empty",
    (field, path) => {
      const result = assumeRole(run, stsReply(undefined, field));
      expect(result.status).not.toBe(0);
      expect(result.output).toBe("");
      expect(result.env).toBe("");
      expect(result.stderr).toMatch(namesPath(path));
    },
  );

  // #160: jq -r read a reply with no value as the word null, and sent it
  // to STS.
  it.each([
    ["has no value", "{}"],
    ["has an empty value", '{"value":""}'],
    ["has a value that is not a string", '{"value":null}'],
    ["is not JSON", "<html>"],
  ])(
    "fails before it calls STS, naming .value, when the OIDC reply %s",
    (_, oidc) => {
      const result = assumeRole(run, stsReply(), oidc);
      expect(result.status).not.toBe(0);
      expect(result.output).toBe("");
      expect(result.env).toBe("");
      expect(result.stderr).not.toContain("aws-called");
      expect(result.stderr).toMatch(/^::error::.*\.value\b/mu);
    },
  );
});

// #250: the eval and conformance role steps stop with an error that points
// at the README when their secret is empty, before curl or STS, rather than
// fail later with an AWS error. The deploy role step has no such check: the
// deploy job does not run when its secret is unset, which
// test/deploy.static.ts holds.
describe.each([
  {
    title: "the eval's role step",
    run: evalRole,
    secret: "AWS_EVAL_ROLE_ARN",
  },
  {
    title: "the conformance run's role step",
    run: conformanceRole,
    secret: "AWS_CONFORMANCE_ROLE_ARN",
  },
])("$title with its role secret unset", ({ run, secret }) => {
  it("fails with an error that names the secret, before it calls curl or STS, and writes nothing", () => {
    const { status, stdout, stderr, env, output } = runStep(
      run,
      {
        curl: "echo curl-called >&2\nexit 1",
        aws: "echo aws-called >&2\nexit 1",
      },
      { ...roleEnv, ROLE: "" },
    );
    expect(status).not.toBe(0);
    expect(`${stdout}${stderr}`).toMatch(
      new RegExp(`^::error::.*\\b${secret}\\b.*README`, "mu"),
    );
    expect(stderr).not.toContain("curl-called");
    expect(stderr).not.toContain("aws-called");
    expect(env).toBe("");
    expect(output).toBe("");
  });
});
