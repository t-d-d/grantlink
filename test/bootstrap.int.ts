// Runs scripts/bootstrap.sh under bash with stub aws, gh and sleep. The
// script's PATH holds only the stubs and the one system command it needs,
// so a call nothing stubs fails instead of reaching AWS or GitHub.
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
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { root } from "./repo.ts";

const [bash = "", tr = ""] = execFileSync(
  "bash",
  ["-c", "command -v bash tr"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");

const roles = "grantlink-github-oidc";

// What each aws call answers, by the name the stub gives the call. Each
// answer is bash, run in the stub. wait_for blocks until a file in $STATE
// exists, so a stub deploy can last as long as the case needs.
type Answers = Record<string, string>;

// A first run: neither stack exists. The DNS deploy makes the zone, then
// lasts until the zone's nameservers are read.
const firstRun: Answers = {
  identity: "echo stub-account",
  parameter: "echo '{}'",
  "status dns": "exit 254",
  [`status ${roles}`]: "exit 254",
  "zone dns": '[ -e "$STATE/zone" ] || exit 254; echo Z-STUB',
  "deploy dns": ': > "$STATE/zone"; wait_for released',
  nameservers:
    ": > \"$STATE/released\"; printf 'ns-1.example\\tns-2.example\\n'",
  [`deploy ${roles}`]: ":",
  [`output ${roles} DeployRoleArn`]: "echo deploy-role",
  [`output ${roles} DeployExecutionRoleArn`]: "echo execution-role",
  [`output ${roles} CiEvalRoleArn`]: "echo eval-role",
  "output dns CertificateArn": "echo certificate",
  "output dns HostedZoneId": "echo Z-STUB",
};

// Names each aws call by what it asks for, logs it, and answers it.
const awsStub = `#!${bash}
. "$STATE/lib.sh"
args="$*"
stack=; query=
while [ $# -gt 0 ]; do
  case $1 in
    --stack-name) stack=$2; shift ;;
    --query) query=$2; shift ;;
  esac
  shift
done
case $args in
  "sts get-caller-identity "*) call=identity ;;
  "ssm get-parameter "*"--name /access/account-id"*) call=parameter ;;
  "cloudformation describe-stacks "*)
    if [ "$query" = "Stacks[0].StackStatus" ]; then
      call="status $stack"
    else
      key=\${query#*OutputKey==\\'}
      call="output $stack \${key%%\\'*}"
    fi ;;
  "cloudformation describe-stack-resource "*"--logical-resource-id HostedZone"*) call="zone $stack" ;;
  "cloudformation deploy "*) call="deploy $stack" ;;
  "cloudformation wait "*)
    waiter=\${args#cloudformation wait }
    call="wait $stack \${waiter%% *}" ;;
  "route53 get-hosted-zone --id Z-STUB "*) call=nameservers ;;
  *) call="unknown: $args" ;;
esac
log "aws $call"
answer "$call"
`;

// Logs what gh is asked to set and the value it reads on standard input.
const ghStub = `#!${bash}
. "$STATE/lib.sh"
log "gh $* < $(</dev/stdin)"
`;

// Each sleep is a tick. A loop that never ends stops at the thirtieth.
const sleepStub = `#!${bash}
. "$STATE/lib.sh"
log "sleep $*"
ticks=$(( $(<"$STATE/ticks") + 1 ))
echo "$ticks" > "$STATE/ticks"
: > "$STATE/slept"
[ "$ticks" -lt 30 ] || { echo "sleep: called $ticks times" >&2; exit 99; }
`;

const library = (answers: Answers): string => `
log() { printf '%s\\n' "$1" >> "$STATE/calls"; }
wait_for() {
  local i
  exec 3<>"$STATE/never"
  for ((i = 0; i < 300; i++)); do
    [ -e "$STATE/$1" ] && return 0
    read -rt 0.01 -u 3 _ || :
  done
  echo "stub: gave up waiting for $1" >&2
  exit 98
}
answer() {
  case $1 in
${Object.entries(answers)
  .map(([call, body]) => `    ${JSON.stringify(call)}) ${body} ;;`)
  .join("\n")}
    *) echo "stub: no answer for $1" >&2; exit 97 ;;
  esac
}
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

interface Run {
  status: number | null;
  stdout: string;
  calls: string[];
}

function run(answers: Answers, setup: string[] = []): Run {
  const state = mkdtempSync(join(tmpdir(), "bootstrap-"));
  dirs.push(state);
  const bin = join(state, "bin");
  mkdirSync(bin);
  execFileSync("mkfifo", [join(state, "never")]);
  for (const file of setup) writeFileSync(join(state, file), "");
  writeFileSync(join(state, "ticks"), "0");
  writeFileSync(join(state, "calls"), "");
  writeFileSync(join(state, "lib.sh"), library(answers));
  for (const [name, body] of [
    ["aws", awsStub],
    ["gh", ghStub],
    ["sleep", sleepStub],
  ] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  symlinkSync(tr, join(bin, "tr"));
  const result = spawnSync(bash, ["scripts/bootstrap.sh"], {
    cwd: root,
    input: "y\n",
    encoding: "utf8",
    env: { PATH: bin, HOME: state, STATE: state, LC_ALL: "C" },
    timeout: 4_000,
  });
  const calls = readFileSync(join(state, "calls"), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  expect(calls.filter((call) => call.includes("unknown:"))).toEqual([]);
  return { status: result.status, stdout: result.stdout, calls };
}

// The calls with the zone polling left out, since how often the loop polls
// depends on timing.
const steps = (calls: string[]): string[] =>
  calls.filter((call) => call !== "aws zone dns" && !call.startsWith("sleep"));

const gives = [
  "gh secret set AWS_DEPLOY_ROLE_ARN --repo t-d-d/grantlink --env prod < deploy-role",
  "gh secret set AWS_DEPLOY_EXECUTION_ROLE_ARN --repo t-d-d/grantlink --env prod < execution-role",
  "gh secret set CERTIFICATE_ARN --repo t-d-d/grantlink --env prod < certificate",
  "gh variable set HOSTED_ZONE_ID --repo t-d-d/grantlink --env prod < Z-STUB",
  "gh secret set PRIVATE_BUCKET_NAME --repo t-d-d/grantlink --env prod < grantlink-text-stub-account",
  "gh secret set PRIVATE_BUCKET_NAME --repo t-d-d/grantlink --env eval < grantlink-text-stub-account",
  "gh secret set AWS_EVAL_ROLE_ARN --repo t-d-d/grantlink --env eval < eval-role",
];

const ghCalls = (calls: string[]): string[] =>
  calls.filter((call) => call.startsWith("gh "));

describe("the bootstrap script, run against stub aws and gh", () => {
  it("applies both stacks on a first run, shows the nameservers while the DNS deploy runs, and gives GitHub every value", () => {
    const { status, stdout, calls } = run(firstRun);
    expect(status).toBe(0);
    expect(steps(calls)).toEqual([
      "aws identity",
      "aws parameter",
      "aws status dns",
      "aws deploy dns",
      "aws nameservers",
      `aws status ${roles}`,
      `aws deploy ${roles}`,
      `aws output ${roles} DeployRoleArn`,
      `aws output ${roles} DeployExecutionRoleArn`,
      `aws output ${roles} CiEvalRoleArn`,
      "aws output dns CertificateArn",
      "aws output dns HostedZoneId",
      ...gives,
    ]);
    expect(stdout).toContain("ns-1.example\nns-2.example\n");
  });

  it("shows a known zone's nameservers, then waits for a DNS stack an earlier run left being created", () => {
    const { status, stdout, calls } = run(
      {
        ...firstRun,
        "status dns": "echo CREATE_IN_PROGRESS",
        "wait dns stack-create-complete": ":",
        "deploy dns": ":",
      },
      ["zone"],
    );
    expect(status).toBe(0);
    expect(steps(calls).slice(0, 6)).toEqual([
      "aws identity",
      "aws parameter",
      "aws nameservers",
      "aws status dns",
      "aws wait dns stack-create-complete",
      "aws deploy dns",
    ]);
    expect(ghCalls(calls)).toEqual(gives);
    expect(stdout).toContain("ns-1.example\nns-2.example\n");
  });

  it("stops on a stack whose first create failed, and changes nothing", () => {
    const { status, stdout, calls } = run({
      ...firstRun,
      "status dns": "echo ROLLBACK_COMPLETE",
    });
    expect(status).toBe(1);
    expect(steps(calls)).toEqual([
      "aws identity",
      "aws parameter",
      "aws status dns",
    ]);
    expect(stdout).toContain("Delete it once its rollback has finished");
  });

  it.each(["echo", "echo None"])(
    "gives GitHub nothing when an output is missing (%s)",
    (answer) => {
      const { status, stdout, calls } = run({
        ...firstRun,
        "output dns CertificateArn": answer,
      });
      expect(status).toBe(1);
      expect(calls).toContain("aws output dns HostedZoneId");
      expect(ghCalls(calls)).toEqual([]);
      expect(stdout).toContain("gave no value for certificate");
    },
  );

  it("stops before it changes anything when the account has no /access/account-id parameter", () => {
    const { status, stdout, calls } = run({
      ...firstRun,
      parameter: "echo 'ParameterNotFound' >&2; exit 254",
    });
    expect(status).toBe(1);
    expect(calls).toEqual(["aws identity", "aws parameter"]);
    expect(stdout).toContain("no /access/account-id parameter");
  });

  it("stops waiting for the zone when the DNS deploy fails before the zone exists", () => {
    const { status, calls } = run({
      ...firstRun,
      "deploy dns": "wait_for slept; exit 255",
    });
    expect(status).toBe(255);
    expect(
      calls.filter((call) => call.startsWith("sleep")).length,
    ).toBeLessThan(30);
    expect(steps(calls)).toEqual([
      "aws identity",
      "aws parameter",
      "aws status dns",
      "aws deploy dns",
    ]);
  });
});
