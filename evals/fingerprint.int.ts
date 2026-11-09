import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { INPUTS, MISSING_INPUT } from "./fingerprint.ts";

// The fingerprint script run against a scratch repository, as eval.yml
// runs it against the live release's commit (#90). Its exit code tells a
// commit that lacks an input apart from any other failure.
const script = join(dirname(fileURLToPath(import.meta.url)), "fingerprint.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// Git sees only the scratch directory: no GIT_DIR or other GIT_* variable
// from a hook or the caller, no user or system config that signs commits
// or runs hooks, and no repository above the scratch directory.
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CEILING_DIRECTORIES: tmpdir(),
};

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir, encoding: "utf8", env, timeout: 2_000 },
  ).trim();
}

// A repository with one commit holding the given inputs, and the commit.
function repoWith(inputs: readonly string[]): { dir: string; commit: string } {
  const dir = scratch("grantlink-fingerprint-");
  git(dir, "init", "--quiet");
  for (const path of inputs) {
    const isFile = /\.(json|yml)$/u.test(path);
    const file = isFile ? join(dir, path) : join(dir, path, "keep.txt");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, path);
  }
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--allow-empty", "-m", "inputs");
  return { dir, commit: git(dir, "rev-parse", "HEAD") };
}

const run = (dir: string, commit: string) =>
  spawnSync(process.execPath, [script, commit], {
    cwd: dir,
    encoding: "utf8",
    env,
    timeout: 4_000,
  });

describe("node evals/fingerprint.ts <commit>", () => {
  it("prints the fingerprint of a commit that holds every input", () => {
    const { dir, commit } = repoWith(INPUTS);
    const result = run(dir, commit);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("exits with its own code when an input is missing at the commit", () => {
    const { dir, commit } = repoWith(
      INPUTS.filter((path) => path !== "src/shared"),
    );
    const result = run(dir, commit);
    expect(result.status).toBe(MISSING_INPUT);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("src/shared");
  });

  it("exits with another code, and says why, when the commit is unknown", () => {
    const { dir } = repoWith(INPUTS);
    const result = run(dir, "f".repeat(40));
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBe(MISSING_INPUT);
    expect(result.stderr).toContain("f".repeat(40));
  });

  it("exits with another code when it is not in a repository at all", () => {
    const dir = scratch("grantlink-no-repo-");
    const result = run(dir, "HEAD");
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBe(MISSING_INPUT);
    expect(result.stderr).not.toBe("");
  });
});
