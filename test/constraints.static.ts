import { describe, expect, it } from "vitest";
import { readRepoFile, repoFiles } from "./repo.ts";

// Every constraint file has the parts docs/constraints/README.md lists, in
// order, and names the decision records behind it.
const files = repoFiles().filter(
  (path) =>
    path.startsWith("docs/constraints/") &&
    path.endsWith(".md") &&
    path !== "docs/constraints/README.md",
);

const PARTS = [
  /^Relevance: \S/mu,
  /^Decision: \S/mu,
  /^Why: \S/mu,
  /^## Rules$/mu,
  /^History: #\d+(?:, #\d+)*$/mu,
];

describe("fitness: every constraint file has its parts (README.md)", () => {
  it("finds the constraint files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s has a title, then each part in order", (path) => {
    const text = readRepoFile(path);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^# \S/u);
    expect(lines[1]).toMatch(/^Relevance: /u);
    expect(lines[2]).toMatch(/^Decision: /u);
    const at = PARTS.map((part) => text.search(part));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it.each(files)(
    "%s states its decision in 160 characters or fewer",
    (path) => {
      const decision = readRepoFile(path)
        .split("\n")
        .find((line) => line.startsWith("Decision: "));
      expect(decision?.slice("Decision: ".length).length).toBeLessThanOrEqual(
        160,
      );
    },
  );
});

describe("fitness: each code rule file names its decision record (README.md)", () => {
  const records = {
    "docs/constraints/durable-execution.md": "#5",
    "docs/constraints/storage.md": "#6",
    "docs/constraints/model-calls.md": "#7",
    "docs/constraints/personal-data.md": "#10",
  };

  it.each(Object.entries(records))("%s cites %s", (path, record) => {
    const history = readRepoFile(path)
      .split("\n")
      .find((line) => line.startsWith("History: "));
    expect(history?.split(/,? /u)).toContain(record);
  });
});
