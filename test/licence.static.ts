import { describe, expect, it } from "vitest";
import { readRepoFile } from "./repo.ts";

// The code is under Apache 2.0, which covers the code only (PRD #1).
describe("fitness: the licence covers the code only (licence.md)", () => {
  it("licenses the code under Apache 2.0", () => {
    expect(readRepoFile("LICENSE")).toMatch(/Apache License\s+Version 2\.0/u);
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      license?: string;
    };
    expect(pkg.license).toBe("Apache-2.0");
  });

  it("says in the README that titles and funding text belong to their publishers", () => {
    expect(readRepoFile("README.md")).toMatch(
      /Paper titles and funding text belong to their publishers, under each paper's own licence\./u,
    );
  });

  it("credits Europe PMC in the README, under EMBL-EBI's terms of use", () => {
    const readme = readRepoFile("README.md");
    expect(readme).toContain("(https://europepmc.org/)");
    expect(readme).toContain("(https://www.ebi.ac.uk/about/terms-of-use/)");
  });
});
