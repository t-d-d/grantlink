import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// The eval's fingerprint: the git hashes of everything that can change its
// result (docs/constraints/evals.md). The same inputs give the same
// fingerprint on any branch, and a revert gets its old one back. Run
//
//   node evals/fingerprint.ts
//
// to print it for HEAD. eval.yml runs it to key the report for its own
// checkout, and deploy.yml runs it to check the report is for main's own
// fingerprint. A missing input, or any other failure, exits non-zero.
export const INPUTS = [
  "src/extract",
  "src/shared",
  "evals",
  ".github/workflows/eval.yml",
  "package-lock.json",
] as const;

export function fingerprint(hashes: Readonly<Record<string, string>>): string {
  const lines = INPUTS.map((path) => {
    const hash = hashes[path];
    if (hash === undefined) throw new Error(`no git hash for ${path}`);
    return `${path} ${hash}`;
  });
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// `git rev-parse --verify --quiet <spec>`: the hash, or null when git
// exits 1 with nothing on stdout, which is how it says the spec does not
// resolve. Any other failure throws with git's own error.
function revParse(spec: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", spec], {
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 1 && result.stdout === "" && result.stderr === "") {
    return null;
  }
  throw new Error(
    `git rev-parse ${spec} failed with status ${String(result.status)}: ${result.stderr.trim()}`,
  );
}

// The git hash of each input at HEAD: a tree for a directory, a blob for a
// file.
export function hashesAtHead(): Record<string, string> {
  if (revParse("HEAD^{commit}") === null) {
    throw new Error("HEAD is not a commit in this repository");
  }
  return Object.fromEntries(
    INPUTS.map((path) => {
      const hash = revParse(`HEAD:${path}`);
      if (hash === null) throw new Error(`${path} does not exist at HEAD`);
      return [path, hash];
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error("usage: node evals/fingerprint.ts");
    process.exitCode = 2;
  } else {
    console.log(fingerprint(hashesAtHead()));
  }
}
