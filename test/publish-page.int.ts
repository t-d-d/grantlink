// Runs scripts/publish-page.sh, the deploy's last write to the page's
// bucket, under bash with a stub aws. The stub keeps the bucket in a
// directory, and can play a run that publishes part way through the deploy
// (#46). The script runs from a copy of the repo's scripts/, site/ and src/,
// so a test can give it the release record a deploy
// writes. The script's PATH holds only the stub and the system commands it
// needs, so a call nothing stubs fails instead of reaching AWS.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
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
import { summarise } from "../src/page/found.ts";
import { buildPage } from "../src/page/render.ts";
import { fakeRelease } from "./fakes.ts";
import { readRepoFile, root } from "./repo.ts";

const commands = [
  "bash",
  "cat",
  "cp",
  "cut",
  "dirname",
  "grep",
  "md5sum",
  "mkdir",
  "mktemp",
  "rm",
];
const found = execFileSync("bash", ["-c", `command -v ${commands.join(" ")}`], {
  encoding: "utf8",
})
  .trim()
  .split("\n");
const bash = found[0] ?? "";

// The bucket is $STATE/bucket, one file per key. An object's ETag is its
// MD5 in quotes, as S3 gives it for a single-part upload. $RACE names the
// call after which a run publishes: found.json first, then index.html, as
// src/store/bucket.ts does.
const awsStub = `#!${bash}
bucket="$STATE/bucket"
log() { printf '%s\\n' "$1" >> "$STATE/calls"; }
etag() { printf '"%s"' "$(md5sum < "$bucket/$1" | cut -d' ' -f1)"; }
run_publishes() {
  cp "$STATE/run/found.json" "$bucket/found.json"
  cp "$STATE/run/index.html" "$bucket/index.html"
  log "run publishes"
}
# A run publishes once.
race() {
  if [ "\${RACE:-}" = "$1" ] && [ ! -e "$STATE/raced" ]; then
    : > "$STATE/raced"
    run_publishes
  fi
}
key=; body=; cache=; if_match=; if_none_match=; delete=; excludes=()
excluded() {
  local pattern
  for pattern in "\${excludes[@]}"; do [ "$1" = "$pattern" ] && return 0; done
  return 1
}
args=("$@")
while [ $# -gt 0 ]; do
  case $1 in
    --delete) delete=1 ;;
    --key) key=$2; shift ;;
    --body) body=$2; shift ;;
    --cache-control) cache=$2; shift ;;
    --if-match) if_match=$2; shift ;;
    --if-none-match) if_none_match=$2; shift ;;
    --exclude) excludes+=("$2"); shift ;;
  esac
  shift
done
set -- "\${args[@]}"
case "$1 $2" in
  "s3api head-object")
    log "head $key"
    if [ "\${FAIL:-}" = "head $key" ]; then
      echo "An error occurred (403) when calling the HeadObject operation: Forbidden" >&2
      exit 254
    fi
    if [ ! -e "$bucket/$key" ]; then
      echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2
      race "head $key"
      exit 254
    fi
    # What --query ETag --output text prints.
    etag "$key"; echo
    race "head $key" ;;
  "s3 cp")
    key=\${3#s3://*/}
    log "get $key"
    cp "$bucket/$key" "$4"
    race "get $key" ;;
  "s3 sync")
    log "sync"
    for file in "$3"*; do
      name=\${file##*/}
      excluded "$name" || {
        cp "$file" "$bucket/$name"
        printf '%s' "$cache" > "$STATE/cache/$name"
        log "put $name"
      }
    done
    if [ -n "$delete" ]; then
      for file in "$bucket"/*; do
        name=\${file##*/}
        [ -e "$3$name" ] || excluded "$name" || { rm "$file"; log "delete $name"; }
      done
    fi
    race sync ;;
  "s3api put-object")
    if [ "\${FAIL:-}" = "put $key" ]; then
      echo "An error occurred (AccessDenied) when calling the PutObject operation: Access Denied" >&2
      exit 254
    fi
    if [ "\${FAIL:-}" = "conflict $key" ]; then
      log "conflict $key"
      echo "An error occurred (ConditionalRequestConflict) when calling the PutObject operation: A conflicting operation occurred" >&2
      exit 254
    fi
    if [ -n "$if_match" ] && [ ! -e "$bucket/$key" ]; then
      log "refused $key"
      echo "An error occurred (NoSuchKey) when calling the PutObject operation: The specified key does not exist." >&2
      exit 254
    fi
    if [ -n "$if_match" ] && [ "$(etag "$key")" != "$if_match" ]; then
      log "refused $key"
      echo "An error occurred (PreconditionFailed) when calling the PutObject operation: At least one of the pre-conditions you specified did not hold" >&2
      exit 254
    fi
    if [ "$if_none_match" = "*" ] && [ -e "$bucket/$key" ]; then
      log "refused $key"
      echo "An error occurred (PreconditionFailed) when calling the PutObject operation: At least one of the pre-conditions you specified did not hold" >&2
      exit 254
    fi
    cp "$body" "$bucket/$key"
    printf '%s' "$cache" > "$STATE/cache/$key"
    log "put $key"
    echo "{\\"ETag\\": $(etag "$key")}" ;;
  "cloudfront create-invalidation") log "invalidate"; echo I-STUB ;;
  "cloudfront wait") log "wait" ;;
  *) log "unknown: $*"; echo "stub: no answer for $*" >&2; exit 97 ;;
esac
`;

const template = readRepoFile("site/index.html");
// Each run finishes at its own time, which the page shows, so the old run's
// page and the new one's differ.
const runs = {
  "run-old": "2026-11-02T10:00:00.000Z",
  "run-new": "2026-11-09T10:00:00.000Z",
};
type RunId = keyof typeof runs;
const summary = (runId: RunId) =>
  summarise([], { runId, finishedAt: runs[runId] });
const data = (runId: RunId) => JSON.stringify(summary(runId));
const page = (runId: RunId) => buildPage(template, summary(runId));

// A run builds its page with the template its own function version holds,
// which a deploy may since have changed.
const older = `<!-- the template before this deploy -->\n${template}`;
const runsPage = buildPage(older, summary("run-new"));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

interface Deploy {
  status: number | null;
  stderr: string;
  stdout: string;
  calls: string[];
  bucket: (key: string) => string | undefined;
  // The Cache-Control the object was last uploaded with.
  cache: (key: string) => string | undefined;
}

it("tells the old run's page from the new one's", () => {
  expect(page("run-old")).not.toBe(page("run-new"));
  expect(runsPage).not.toBe(page("run-new"));
});

// Publishes with the bucket holding `before`, and a run that publishes
// `run-new` after the call `race` names, if any. `record` is the release
// record the deploy wrote, as site/release.json.
function deploy(
  before: Record<string, string>,
  options: { race?: string; fail?: string; record?: string } = {},
): Deploy {
  const state = mkdtempSync(join(tmpdir(), "publish-page-"));
  dirs.push(state);
  const bin = join(state, "bin");
  const bucket = join(state, "bucket");
  const runDir = join(state, "run");
  const repo = join(state, "repo");
  const cache = join(state, "cache");
  for (const dir of [bin, bucket, runDir, cache, repo]) mkdirSync(dir);
  // build.ts runs only as the main module, which Node finds by its real
  // path, so src/ is copied rather than linked.
  for (const dir of ["scripts", "site", "src"])
    cpSync(join(root, dir), join(repo, dir), { recursive: true });
  for (const dir of ["evals", "node_modules", "package.json"])
    symlinkSync(join(root, dir), join(repo, dir));
  if (options.record !== undefined)
    writeFileSync(join(repo, "site", "release.json"), options.record);
  for (const [key, body] of Object.entries(before))
    writeFileSync(join(bucket, key), body);
  writeFileSync(join(runDir, "found.json"), data("run-new"));
  writeFileSync(join(runDir, "index.html"), runsPage);
  writeFileSync(join(state, "calls"), "");
  writeFileSync(join(bin, "aws"), awsStub);
  chmodSync(join(bin, "aws"), 0o755);
  for (const path of found) symlinkSync(path, join(bin, basename(path)));
  symlinkSync(process.execPath, join(bin, "node"));
  const result = spawnSync(bash, ["scripts/publish-page.sh"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: bin,
      HOME: state,
      TMPDIR: state,
      STATE: state,
      LC_ALL: "C",
      BUCKET: "grantlink-site-stub",
      DISTRIBUTION: "D-STUB",
      RACE: options.race ?? "",
      FAIL: options.fail ?? "",
    },
    timeout: 4_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  const calls = readFileSync(join(state, "calls"), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  expect(calls.filter((call) => call.startsWith("unknown:"))).toEqual([]);
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    calls,
    bucket: (key) =>
      existsSync(join(bucket, key))
        ? readFileSync(join(bucket, key), "utf8")
        : undefined,
    cache: (key) =>
      existsSync(join(cache, key))
        ? readFileSync(join(cache, key), "utf8")
        : undefined,
  };
}

// A run has published once, before this deploy.
const published = {
  "found.json": data("run-old"),
  "index.html": "the page as the old template built it",
  "style.css": "old style",
  "gone.css": "a file the site no longer has",
};

describe("the deploy publishes the page", () => {
  it("builds the page again from the last run's data, and leaves found.json alone", () => {
    const result = deploy(published);
    expect(result.status, result.stderr).toBe(0);
    expect(result.bucket("index.html")).toBe(page("run-old"));
    expect(result.bucket("found.json")).toBe(data("run-old"));
    expect(result.bucket("style.css")).toBe(readRepoFile("site/style.css"));
    expect(result.bucket("gone.css")).toBeUndefined();
    expect(result.calls.slice(-2)).toEqual(["invalidate", "wait"]);
  });

  it("publishes the template before the first run", () => {
    const result = deploy({});
    expect(result.status, result.stderr).toBe(0);
    expect(result.bucket("index.html")).toBe(template);
    expect(result.bucket("found.json")).toBeUndefined();
  });

  it("leaves the repo's own copy of the page as it was", () => {
    deploy(published);
    expect(readRepoFile("site/index.html")).toBe(template);
  });

  it("stops before it writes anything when it cannot read the bucket", () => {
    const result = deploy(published, { fail: "head found.json" });
    expect(result.status).not.toBe(0);
    expect(result.calls.filter((call) => call.startsWith("put"))).toEqual([]);
    expect(result.bucket("index.html")).toBe(published["index.html"]);
  });
});

// The deploy keeps the run's findings, and shows them with its own template.
describe("a run that publishes during a deploy keeps its page (#46)", () => {
  it("after the deploy has read found.json", () => {
    const result = deploy(published, { race: "get found.json" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("run publishes");
    expect(result.calls).toContain("refused index.html");
    expect(result.bucket("found.json")).toBe(data("run-new"));
    expect(result.bucket("index.html")).toBe(page("run-new"));
    expect(result.calls.slice(-2)).toEqual(["invalidate", "wait"]);
  });

  it("after the deploy has uploaded the rest of the site", () => {
    const result = deploy(published, { race: "sync" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("refused index.html");
    expect(result.bucket("index.html")).toBe(page("run-new"));
  });

  it("before the first run's page, while the deploy publishes the template", () => {
    const result = deploy({}, { race: "head found.json" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("refused index.html");
    expect(result.bucket("index.html")).toBe(page("run-new"));
  });

  it("but a write that keeps conflicting stops the deploy after three tries", () => {
    const result = deploy(published, { fail: "conflict index.html" });
    expect(result.status).not.toBe(0);
    expect(
      result.calls.filter((call) => call === "conflict index.html"),
    ).toHaveLength(3);
    expect(result.bucket("index.html")).toBe(published["index.html"]);
  });

  it("and any other failed upload stops the deploy at once", () => {
    const result = deploy(published, { fail: "put index.html" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("AccessDenied");
  });
});

// The eval reads which release is live from /release.json (#85), so the
// record goes up only once the page that shows it has (#119).
describe("the deploy publishes the release record with the page", () => {
  const live = JSON.stringify(fakeRelease(100));
  const record = JSON.stringify(fakeRelease(200));
  const before = { ...published, "release.json": live };
  const withRecord = (fields: Parameters<typeof deploy>[1] = {}) =>
    deploy(before, { record, ...fields });

  it("after index.html, and uncached", () => {
    const result = withRecord();
    expect(result.status, result.stderr).toBe(0);
    expect(result.bucket("release.json")).toBe(record);
    expect(result.cache("release.json")).toBe("no-cache");
    expect(result.calls.indexOf("put release.json")).toBeGreaterThan(
      result.calls.indexOf("put index.html"),
    );
    expect(result.bucket("index.html")).toBe(
      buildPage(template, summary("run-old"), fakeRelease(200)),
    );
  });

  it("after a run's page has made the deploy build it again", () => {
    const result = withRecord({ race: "sync" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("refused index.html");
    expect(result.bucket("release.json")).toBe(record);
  });

  it("not when S3 keeps refusing index.html", () => {
    const result = withRecord({ fail: "conflict index.html" });
    expect(result.status).not.toBe(0);
    expect(result.bucket("release.json")).toBe(live);
  });

  it("not when S3 refuses index.html for any other reason", () => {
    const result = withRecord({ fail: "put index.html" });
    expect(result.status).not.toBe(0);
    expect(result.bucket("release.json")).toBe(live);
  });
});
