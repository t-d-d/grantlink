import { describe, expect, it } from "vitest";
import { readRepoFile } from "./repo.ts";

// A failing command inside `echo "x=$(cmd)"` does not stop a step, even
// under `set -e`, so the step succeeds with an empty value (#92, #111). A
// step assigns the value to a variable on its own line first, which does
// fail, and then writes the variable.
const files = [".github/workflows/eval.yml", ".github/workflows/deploy.yml"];
const echoesASubstitution = /\becho\b[^\n]*(\$\(|`)/u;

describe("workflow steps hand on what a command printed only if it succeeded", () => {
  it.each(files)("%s has no echo whose arguments run a command", (file) => {
    const lines = readRepoFile(file)
      .split("\n")
      .map((line, index) => `${String(index + 1)}: ${line.trim()}`)
      .filter((line) => echoesASubstitution.test(line));
    expect(lines).toEqual([]);
  });
});
