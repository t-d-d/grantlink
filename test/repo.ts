import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));

export function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

// Tracked files and new ones git does not ignore. With -z git writes each
// path as it is, where it would otherwise quote one with a letter outside
// ASCII.
let files: string[] | undefined;
export function repoFiles(): string[] {
  files ??= execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path !== "");
  return [...files];
}
