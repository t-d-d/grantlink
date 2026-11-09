import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INPUTS, MISSING_INPUT } from "./fingerprint.ts";

// The fingerprint script run against a scratch repository, as eval.yml
// runs it against the live release's commit (#90). Its exit code tells a
// commit that lacks an input apart from any other failure.
const script = join(dirname(fileURLToPath(import.meta.url)), "fingerprint.ts");

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir, encoding: "utf8" },
  ).trim();
}

// A repository with one commit holding the given inputs, and the commit.
function repoWith(inputs: readonly string[]): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), "grantlink-fingerprint-"));
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
  spawnSync(process.execPath, [script, commit], { cwd: dir, encoding: "utf8" });

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
    const dir = mkdtempSync(join(tmpdir(), "grantlink-no-repo-"));
    const result = run(dir, "HEAD");
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBe(MISSING_INPUT);
    expect(result.stderr).not.toBe("");
  });
});
