import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// The eval's fingerprint: the git hashes of everything that can change its
// result (docs/constraints/evals.md). The same inputs give the same
// fingerprint on any branch, and a revert gets its old one back. Run
//
//   node evals/fingerprint.ts [<commit>]
//
// to print it for a commit, HEAD by default. It exits with MISSING_INPUT
// when an input does not exist at that commit, and with another non-zero
// code for any other failure, so eval.yml can tell the two apart (#90).
export const INPUTS = [
  "src/extract",
  "src/shared",
  "evals",
  ".github/workflows/eval.yml",
  "package-lock.json",
] as const;

export const MISSING_INPUT = 3;

// An input with no git hash at the commit: the commit predates it.
export class MissingInput extends Error {}

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

// The git hash of each input at a commit: a tree for a directory, a blob for
// a file. The commit itself must exist; only a missing input is MissingInput.
export function hashesAt(commit: string): Record<string, string> {
  if (revParse(`${commit}^{commit}`) === null) {
    throw new Error(`${commit} is not a commit in this repository`);
  }
  return Object.fromEntries(
    INPUTS.map((path) => {
      const hash = revParse(`${commit}:${path}`);
      if (hash === null) {
        throw new MissingInput(`${path} does not exist at ${commit}`);
      }
      return [path, hash];
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(fingerprint(hashesAt(process.argv[2] ?? "HEAD")));
  } catch (error) {
    if (!(error instanceof MissingInput)) throw error;
    console.error(error.message);
    process.exitCode = MISSING_INPUT;
  }
}
