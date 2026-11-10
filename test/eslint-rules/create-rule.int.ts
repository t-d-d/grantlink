import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoPath } from "../../eslint-rules/create-rule.ts";
import { root } from "../repo.ts";

// An editor or shell may reach the repo through a symlink, as macOS does
// for anything under /var, and ESLint hands the rule the path it was given.
// The rules' own root is the real path, so repoPath must resolve the link
// to name the file from the root (#402).
describe("repoPath through a symlink to the repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-path-"));
  const link = join(dir, "checkout");
  symlinkSync(root, link, "dir");

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("names a file on disk from the repo root", () => {
    expect(
      repoPath({ filename: join(link, "src/run/run.ts"), cwd: link }),
    ).toBe("src/run/run.ts");
  });

  // An editor lints a buffer before it is saved, so the file need not
  // exist.
  it("names a file not yet on disk from the repo root", () => {
    expect(
      repoPath({ filename: join(link, "src/run/not-saved.ts"), cwd: link }),
    ).toBe("src/run/not-saved.ts");
  });

  it("resolves a relative filename from a directory reached through the link", () => {
    expect(repoPath({ filename: "run/run.ts", cwd: join(link, "src") })).toBe(
      "src/run/run.ts",
    );
  });
});
