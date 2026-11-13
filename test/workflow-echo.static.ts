import { describe, expect, it } from "vitest";
import { readRepoFile, repoFiles } from "./repo.ts";

// A failing command inside `echo "x=$(cmd)"` does not stop a step, even
// under `set -e`, so the step succeeds with an empty value (#92, #111). A
// step assigns the value to a variable on its own line first, which does
// fail, and then writes the variable. `export`, `local`, `declare` and
// `readonly` return their own status, so an assignment behind one of them
// hides the failure too. The local actions' steps are read the same way.
const files = repoFiles().filter(
  (path) =>
    /^\.github\/(?:workflows|actions)\//u.test(path) && /\.ya?ml$/u.test(path),
);
const printsASubstitution = /\b(?:echo|printf)\b[^\n]*(?:\$\(|`)/u;
const declaresASubstitution =
  /\b(?:export|local|declare|readonly)\s[^\n]*=[^\n]*(?:\$\(|`)/u;

function matching(file: string, pattern: RegExp): string[] {
  return readRepoFile(file)
    .split("\n")
    .map((line, index) => `${String(index + 1)}: ${line.trim()}`)
    .filter((line) => pattern.test(line));
}

describe("workflow steps hand on what a command printed only if it succeeded", () => {
  it("finds the workflows", () => {
    expect(files).toContain(".github/workflows/eval.yml");
    expect(files).toContain(".github/workflows/deploy.yml");
    expect(files).toContain(".github/actions/assume-role/action.yml");
  });

  it.each(files)(
    "%s has no echo or printf whose arguments run a command",
    (file) => {
      expect(matching(file, printsASubstitution)).toEqual([]);
    },
  );

  it.each(files)("%s declares no variable from a command", (file) => {
    expect(matching(file, declaresASubstitution)).toEqual([]);
  });
});
