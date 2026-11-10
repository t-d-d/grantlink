import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoPath } from "../../eslint-rules/create-rule.ts";
import { root } from "../repo.ts";

// ESLint's CLI hands a rule the file's absolute path and the directory it
// runs in. The rules compare repo paths, so the answer must not depend on
// that directory.
describe("repoPath", () => {
  const filename = join(root, "src/run/run.ts");

  it.each([root, join(root, "src"), join(root, "src/run"), "/"])(
    "names src/run/run.ts the same when ESLint runs in %s",
    (cwd) => {
      expect(repoPath({ filename, cwd })).toBe("src/run/run.ts");
    },
  );

  it("resolves a relative filename from the directory ESLint runs in", () => {
    expect(repoPath({ filename: "run/run.ts", cwd: join(root, "src") })).toBe(
      "src/run/run.ts",
    );
  });
});
