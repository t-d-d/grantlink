// Runs scripts/check-stack.sh, the deploy's check on the app stack before
// sls deploy (#89), under bash with a stub aws. The stub answers from the
// environment: the stack's status, whether it lists TextBucket, its latest
// page of events, and what S3 says about the funding text bucket. The
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
bucket=; stack=; output=json; query=
args=("$@")
while [ $# -gt 0 ]; do
  case $1 in
    --bucket) bucket=$2; shift ;;
    --output) output=$2; shift ;;
    --query) query=$2; shift ;;
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
    log "query $query"
    [ -n "$STATUS" ] || missing DescribeStackEvents
    # One row per event, newest first, as the script's --query renders it.
    [ -z "\${EVENTS:-}" ] || printf '%s\\n' "$EVENTS" ;;
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
  // The latest page of events, newest first: logical id, status, and
  // whether the event starts an operation the user asked for.
  events?: string[];
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
      EVENTS: (stack.events ?? []).join("\n"),
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
      events: [
        "TextBucket\tDELETE_FAILED\tFalse",
        "grantlink-prod\tUPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS\tFalse",
        "grantlink-prod\tUPDATE_ROLLBACK_IN_PROGRESS\tFalse",
        "RunLambdaFunction\tUPDATE_FAILED\tFalse",
        "grantlink-prod\tUPDATE_IN_PROGRESS\tTrue",
      ],
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
      events: [
        "grantlink-prod\tUPDATE_ROLLBACK_FAILED\tFalse",
        "RunLambdaFunction\tUPDATE_FAILED\tFalse",
        "grantlink-prod\tUPDATE_ROLLBACK_IN_PROGRESS\tFalse",
        "grantlink-prod\tUPDATE_IN_PROGRESS\tTrue",
      ],
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("RunLambdaFunction (UPDATE_FAILED)");
    expect(result.output).toMatch(/continue the rollback/iu);
  });

  it("says to delete a stack whose first create failed", () => {
    const result = check({
      status: "ROLLBACK_COMPLETE",
      events: [
        "grantlink-prod\tROLLBACK_COMPLETE\tFalse",
        "grantlink-prod\tROLLBACK_IN_PROGRESS\tFalse",
        "RunLambdaFunction\tCREATE_FAILED\tFalse",
        "grantlink-prod\tCREATE_IN_PROGRESS\tTrue",
      ],
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

  it("names the stack, not a resource that failed in an earlier operation (#129)", () => {
    const result = check({
      status: "UPDATE_IN_PROGRESS",
      events: [
        "RunLambdaFunction\tUPDATE_IN_PROGRESS\tFalse",
        "grantlink-prod\tUPDATE_IN_PROGRESS\tTrue",
        "grantlink-prod\tUPDATE_ROLLBACK_COMPLETE\tFalse",
        "grantlink-prod\tUPDATE_ROLLBACK_IN_PROGRESS\tFalse",
        "ResultsTable\tUPDATE_FAILED\tFalse",
        "grantlink-prod\tUPDATE_IN_PROGRESS\tTrue",
      ],
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("grantlink-prod is in UPDATE_IN_PROGRESS");
    expect(result.output).toContain("No resource in it has failed.");
    expect(result.output).not.toContain("ResultsTable (");
  });

  it("names a resource that failed in the current operation, before its rollback began (#129)", () => {
    const result = check({
      status: "UPDATE_ROLLBACK_IN_PROGRESS",
      events: [
        "grantlink-prod\tUPDATE_ROLLBACK_IN_PROGRESS\tFalse",
        "RunLambdaFunction\tUPDATE_FAILED\tFalse",
        "grantlink-prod\tUPDATE_IN_PROGRESS\tTrue",
        "ResultsTable\tUPDATE_FAILED\tFalse",
      ],
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("RunLambdaFunction (UPDATE_FAILED)");
    expect(result.output).not.toContain("ResultsTable (");
  });

  // The stub hands back rows already split into columns, so this checks
  // the query that marks where the current operation starts (#129).
  it("marks the stack's own User Initiated event as the start of the current operation (#129)", () => {
    const result = check({ status: "UPDATE_IN_PROGRESS" });
    const query = result.calls.find((call) => call.startsWith("query "));
    expect(query).toContain(
      "LogicalResourceId=='grantlink-prod' && ResourceStatusReason=='User Initiated'",
    );
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

  // The owner chose this recovery on #129: with no stack, there is nothing
  // to import the bucket into.
  it("says to empty and delete the bucket when there is no stack, keeping any eval snapshot first (#129)", () => {
    const result = check({ bucket: "403" });
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/empty and delete the funding text bucket/iu);
    expect(result.output).toMatch(/run this deploy again/u);
    expect(result.output).toContain("eval/");
    expect(result.output).toMatch(/copy it out first/iu);
    expect(result.output).not.toMatch(/import/iu);
    expect(result.output).not.toMatch(/grantlink-text/u);
  });

  // After an established stack is deleted, the retained bucket still holds
  // every paper's funding text and the eval reports CI filed, so the advice
  // names every prefix to keep before the bucket goes (#197).
  it("says to copy out the funding text, the eval snapshot and the eval reports before deleting the bucket (#197)", () => {
    const result = check({ bucket: "403" });
    expect(result.status).not.toBe(0);
    for (const prefix of ["cache/", "eval/", "eval-reports/"])
      expect(result.output).toContain(prefix);
    expect(result.output).toMatch(/deleted/iu);
    const advice = result.output.toLowerCase();
    expect(advice.indexOf("copy")).toBeGreaterThan(-1);
    expect(advice.indexOf("copy")).toBeLessThan(
      advice.indexOf("empty and delete"),
    );
    expect(result.output).toMatch(/copy back what you kept/iu);
    // Funding text names people and stays in private storage in eu-west-2
    // (personal-data.md), so the copy goes to a bucket like the one it
    // left.
    expect(result.output).toMatch(/to a private bucket in eu-west-2/iu);
  });

  // The results table is retained and has no fixed name, so a deleted
  // stack leaves it behind and the next deploy makes a new, empty one. A
  // run on an empty table fetches every paper again, which europe-pmc.md
  // does not allow, so the advice says to copy the rows over before the
  // first run starts (#254).
  it("says the old results table is left behind and how to copy its rows to the new one (#254)", () => {
    const result = check({ bucket: "403" });
    expect(result.status).not.toBe(0);
    const advice = result.output;
    expect(advice).toContain("ResultsTable");
    expect(advice).toMatch(/left behind/iu);
    // The old table keeps its generated name; the new one is the stack's
    // ResultsTableName output.
    expect(advice).toContain("grantlink-prod-ResultsTable-");
    expect(advice).toContain("ResultsTableName");
    expect(advice).toMatch(/copy every item/iu);
    expect(advice).toContain("aws dynamodb scan");
    expect(advice).toContain("batch-write-item");
    // The deploy that creates the stack starts the first run a quarter of
    // an hour later, and that run must find the rows.
    expect(advice).toMatch(/before the first run/iu);
    // The deploy sets the first run's time before sls deploy starts, so
    // making the stack uses up part of the quarter of an hour.
    expect(advice).toMatch(/quarter of an hour after that deploy starts/iu);
    expect(advice).not.toMatch(/quarter of an hour after it makes/iu);
    // A run fetches every paper it has no row for, whatever cache/ holds,
    // so the advice does not say the cache saves that.
    expect(advice).not.toMatch(/cache saves fetching/iu);
    // ResultsTable is retained on a failed first create too, so one may be
    // left behind empty, and more than one may be there.
    expect(advice).not.toMatch(/not there, as after a failed first create/iu);
    expect(advice).toMatch(/more than one/iu);
    expect(advice).toMatch(/holds items/iu);
    // The table's advice comes after the bucket's, once the deploy has
    // made the new table.
    expect(advice.indexOf("ResultsTable")).toBeGreaterThan(
      advice.indexOf("run this deploy again"),
    );
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
