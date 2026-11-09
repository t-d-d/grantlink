import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, loadSnapshot } from "./run.ts";

// The runner against a snapshot written to a directory, laid out as the
// bucket is.
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function snapshotDir(papers: Record<string, string[]>) {
  const dir = mkdtempSync(join(tmpdir(), "grantlink-eval-"));
  mkdirSync(join(dir, "eval/papers"), { recursive: true });
  mkdirSync(join(dir, "eval/s1"), { recursive: true });
  const entries = Object.entries(papers).map(([pmcid, text]) => {
    const body = JSON.stringify({ pmcid, text, awards: [] });
    writeFileSync(join(dir, `eval/papers/${pmcid}.json`), body);
    return { pmcid, set: "A", sha256: sha(body), grants: ["A11111"] };
  });
  const manifest = JSON.stringify({
    id: "s1",
    createdAt: "2026-11-09T12:00:00.000Z",
    goldA: { query: "q", seed: 1, size: 2 },
    papers: entries,
  });
  writeFileSync(join(dir, "eval/s1/manifest.json"), manifest);
  return { dir, manifestSha256: sha(manifest) };
}

const papers = {
  PMC1: ["Funded by Cancer Research UK grant A11111."],
  PMC2: ["Funded by Cancer Research UK."],
};

describe("the eval runner", () => {
  it("reads a snapshot whose manifest matches the pin", () => {
    const { dir, manifestSha256 } = snapshotDir(papers);
    const texts = loadSnapshot(dir, { id: "s1", manifestSha256 });
    expect([...texts.keys()]).toEqual(["PMC1", "PMC2"]);
    expect(texts.get("PMC1")?.text).toEqual(papers.PMC1);
  });

  it("refuses a manifest that does not match the pin", () => {
    const { dir } = snapshotDir(papers);
    expect(() =>
      loadSnapshot(dir, { id: "s1", manifestSha256: "0".repeat(64) }),
    ).toThrow(/manifest/u);
  });

  it("refuses a paper whose text does not match the manifest", () => {
    const { dir, manifestSha256 } = snapshotDir(papers);
    writeFileSync(
      join(dir, "eval/papers/PMC2.json"),
      JSON.stringify({ pmcid: "PMC2", text: ["changed"], awards: [] }),
    );
    expect(() => loadSnapshot(dir, { id: "s1", manifestSha256 })).toThrow(
      /PMC2/u,
    );
    // The error names the paper, never its text.
    try {
      loadSnapshot(dir, { id: "s1", manifestSha256 });
    } catch (error) {
      expect(String(error)).not.toContain("changed");
    }
  });

  it("reads nothing before a snapshot is pinned", () => {
    expect(
      loadSnapshot("/nowhere", { id: "s1", manifestSha256: null }).size,
    ).toBe(0);
  });

  it("scores the release and the rules-only baseline", () => {
    const { dir, manifestSha256 } = snapshotDir(papers);
    const texts = loadSnapshot(dir, { id: "s1", manifestSha256 });
    const result = evaluate({
      texts,
      goldA: [
        { pmcid: "PMC1", grants: ["A11111"] },
        { pmcid: "PMC2", grants: ["A22222"] },
      ],
      goldB: [],
    });
    const recall = (rows: typeof result.rows) =>
      rows.find((row) => row.id === "recall-a")?.score;
    expect(recall(result.rows)).toBe(0.5);
    expect(recall(result.baseline)).toBe(0.5);
    expect(result.missedA).toEqual(["PMC2"]);
    // The manifest was read from disk, and nothing was written there.
    expect(readFileSync(join(dir, "eval/s1/manifest.json"), "utf8")).toContain(
      "PMC1",
    );
  });
});
