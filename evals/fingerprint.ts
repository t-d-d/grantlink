import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// The eval's fingerprint: the git hashes of everything that can change its
// result (docs/constraints/evals.md). The same inputs give the same
// fingerprint on any branch, and a revert gets its old one back. Run
//
//   node evals/fingerprint.ts [<commit>]
//
// to print it for a commit, HEAD by default.
export const INPUTS = [
  "src/extract",
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

// The git hash of each input at a commit: a tree for a directory, a blob for
// a file.
export function hashesAt(commit: string): Record<string, string> {
  return Object.fromEntries(
    INPUTS.map((path) => [
      path,
      execFileSync("git", ["rev-parse", `${commit}:${path}`], {
        encoding: "utf8",
      }).trim(),
    ]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(fingerprint(hashesAt(process.argv[2] ?? "HEAD")));
}
