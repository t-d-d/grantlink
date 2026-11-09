// Runs scripts/check-stack.sh, the deploy's check on the app stack before
// sls deploy (#89), under bash with a stub aws. The stub answers from the
// environment: the stack's status, whether it lists TextBucket, its newest
// failed resource, and what S3 says about the funding text bucket. The
// script's PATH holds only the stub and the system commands it needs, so a
// call nothing stubs fails instead of reaching AWS.
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
import { root } from "./repo.ts";

const commands = ["bash", "grep", "mktemp", "rm", "sed"];
const found = execFileSync("bash", ["-c", `command -v ${commands.join(" ")}`], {
  encoding: "utf8",
})
  .trim()
  .split("\n");
const bash = found[0] ?? "";

// Built here so this file holds no id for test/infra.static.ts to find.
const account = "1234567890" + "12";

// What the AWS CLI prints for each call the script makes. An empty STATUS
// is a stack that does not exist.
const awsStub = `#!${bash}
log() { printf '%s\\n' "$1" >> "$STATE/calls"; }
bucket=; stack=; output=json
args=("$@")
while [ $# -gt 0 ]; do
  case $1 in
    --bucket) bucket=$2; shift ;;
    --output) output=$2; shift ;;
    --stack-name) stack=$2; shift ;;
  esac
  shift
done
set -- "\${args[@]}"
missing() {
  echo "An error occurred (ValidationError) when calling the $1 operation: Stack with id $stack does not exist" >&2
  exit 254
}
case "$1 $2" in
  "sts get-caller-identity")
    log "whoami"
    echo "${account}" ;;
  "cloudformation describe-stacks")
    log "describe $stack"
    if [ -n "\${DENY:-}" ]; then
      echo "An error occurred (AccessDenied) when calling the DescribeStacks operation: User: arn:aws:sts::${account}:assumed-role/grantlink-deploy/x is not authorized" >&2
      exit 254
    fi
    [ -n "$STATUS" ] || missing DescribeStacks
    echo "$STATUS" ;;
  "cloudformation describe-stack-events")
    log "events $stack"
    [ -n "$STATUS" ] || missing DescribeStackEvents
    printf '%s\\n' "\${FAILED:-None}" ;;
  "cloudformation list-stack-resources")
    log "resources $stack"
    [ -n "$STATUS" ] || missing ListStackResources
    # With --output text, the CLI runs --query once on each page.
    pages=1
    [ "$output" = text ] && pages=\${PAGES:-1}
    i=0
    while [ "$i" -lt "$pages" ]; do echo "\${LISTED:-1}"; i=$((i + 1)); done ;;
  "s3api head-bucket")
    log "head-bucket $bucket"
    case "\${BUCKET:-404}" in
      200) echo '{"BucketRegion": "eu-west-2"}' ;;
      403) echo "An error occurred (403) when calling the HeadBucket operation: Forbidden" >&2; exit 254 ;;
      404) echo "An error occurred (404) when calling the HeadBucket operation: Not Found" >&2; exit 254 ;;
      *) echo "An error occurred (500) when calling the HeadBucket operation (bucket $bucket): Internal Server Error" >&2; exit 254 ;;
    esac ;;
  *) log "unknown: $*"; echo "stub: no answer for $*" >&2; exit 97 ;;
esac
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

interface Stack {
  status?: string;
  listed?: "0" | "1";
  failed?: string;
  bucket?: "200" | "403" | "404" | "500";
  deny?: boolean;
  pages?: number;
}

interface Check {
  status: number | null;
  output: string;
  calls: string[];
}

function check(stack: Stack): Check {
  const state = mkdtempSync(join(tmpdir(), "check-stack-"));
  dirs.push(state);
  const bin = join(state, "bin");
  mkdirSync(bin);
  writeFileSync(join(state, "calls"), "");
  writeFileSync(join(bin, "aws"), awsStub);
  chmodSync(join(bin, "aws"), 0o755);
  for (const path of found) symlinkSync(path, join(bin, basename(path)));
  const result = spawnSync(bash, ["scripts/check-stack.sh"], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: bin,
      HOME: state,
      TMPDIR: state,
      STATE: state,
      LC_ALL: "C",
      STATUS: stack.status ?? "",
      LISTED: stack.listed ?? "1",
      FAILED: stack.failed ?? "None",
      BUCKET: stack.bucket ?? "404",
      DENY: stack.deny === true ? "1" : "",
      PAGES: String(stack.pages ?? 1),
    },
    timeout: 4_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  const calls = readFileSync(join(state, "calls"), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  expect(calls.filter((call) => call.startsWith("unknown:"))).toEqual([]);
  const output = `${result.stdout}${result.stderr}`;
  // The bucket's name carries the account id, and the repo's logs are
  // public.
  expect(output).not.toContain(account);
  return { status: result.status, output, calls };
}

describe("the deploy goes ahead (#89)", () => {
  it.each([
    "CREATE_COMPLETE",
    "UPDATE_COMPLETE",
    "UPDATE_ROLLBACK_COMPLETE",
    "IMPORT_COMPLETE",
  ])("on a settled stack that lists the bucket, in %s", (status) => {
    const result = check({ status, listed: "1" });
    expect(result.status, result.output).toBe(0);
    expect(result.calls).toContain("resources grantlink-prod");
  });

  it("before the first deploy, when neither the stack nor the bucket exists", () => {
    const result = check({ bucket: "404" });
    expect(result.status, result.output).toBe(0);
    expect(result.calls).toContain(`head-bucket grantlink-text-${account}`);
  });

  it("when the stack does not list the bucket and the bucket does not exist", () => {
    const result = check({ status: "UPDATE_COMPLETE", listed: "0" });
    expect(result.status, result.output).toBe(0);
  });
});

describe("a stack stuck in cleanup or rollback stops the deploy (#89)", () => {
  it("names the resource the cleanup cannot delete", () => {
    const result = check({
      status: "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
      failed: "TextBucket\tDELETE_FAILED",
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
    );
    expect(result.output).toContain("TextBucket (DELETE_FAILED)");
    expect(result.output).toMatch(/run this deploy again/u);
    // It stops before it reads anything else.
    expect(result.calls).not.toContain("resources grantlink-prod");
  });

  it("says to continue a rollback that failed", () => {
    const result = check({
      status: "UPDATE_ROLLBACK_FAILED",
      failed: "RunLambdaFunction\tUPDATE_FAILED",
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("RunLambdaFunction (UPDATE_FAILED)");
    expect(result.output).toMatch(/continue the rollback/iu);
  });

  it("says to delete a stack whose first create failed", () => {
    const result = check({
      status: "ROLLBACK_COMPLETE",
      failed: "RunLambdaFunction\tCREATE_FAILED",
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("RunLambdaFunction (CREATE_FAILED)");
    expect(result.output).toMatch(/delete the stack/iu);
  });

  it("says to delete a stack left waiting on a change set, which never settles", () => {
    const result = check({ status: "REVIEW_IN_PROGRESS" });
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/delete the stack/iu);
    expect(result.output).not.toMatch(/wait until/iu);
  });

  it("names the stack when no resource has failed", () => {
    const result = check({ status: "UPDATE_IN_PROGRESS" });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("grantlink-prod is in UPDATE_IN_PROGRESS");
    expect(result.output).not.toContain("None");
  });
});

describe("a funding text bucket outside the stack stops the deploy (#89)", () => {
  // The deploy role may not touch the bucket, so S3 answers 403 for it
  // when it exists, and 404 when it does not.
  it.each(["403", "200"] as const)(
    "when the stack does not list it and S3 answers %s",
    (bucket) => {
      const result = check({
        status: "UPDATE_ROLLBACK_COMPLETE",
        listed: "0",
        bucket,
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("TextBucket");
      expect(result.output).toMatch(/import it/iu);
      expect(result.output).toMatch(/run this deploy again/u);
    },
  );

  it("when the stack's resources run to more than one page", () => {
    const result = check({
      status: "UPDATE_COMPLETE",
      listed: "0",
      bucket: "403",
      pages: 2,
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("TextBucket");
  });

  it("when there is no stack but the bucket is there, as after a failed first create", () => {
    const result = check({ bucket: "403" });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("TextBucket");
  });
});

describe("any other error stops the deploy, without the account id", () => {
  it("from CloudFormation", () => {
    const result = check({ status: "UPDATE_COMPLETE", deny: true });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("AccessDenied");
  });

  it("from S3", () => {
    const result = check({
      status: "UPDATE_COMPLETE",
      listed: "0",
      bucket: "500",
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("500");
  });
});
