import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { shownScore } from "./floors.ts";
import { report, verdict, type Judged, type Report } from "./report.ts";

// What CI does with a report (docs/constraints/deploy-gates.md). Run
//
//   node evals/check.ts gate <report.json> <fingerprint>
//
// to stop a merge or a deploy whose report is below a gating floor, or was
// filed for other inputs, and
//
//   node evals/check.ts comment <report.json> <live report.json>
//   node evals/check.ts comment <report.json> --no-live <reason>
//
// to print the pull request's comment, beside the live release's report or
// saying why there is none to compare with (#88).

export const MARKER = "<!-- grantlink:eval -->";

const shown = (row: Judged, score: number | null): string =>
  shownScore(row.id, score);

export function gate(
  raw: string,
  fingerprint: string,
): { pass: boolean; lines: string[] } {
  const parsed = report.parse(JSON.parse(raw));
  const judged = verdict(parsed);
  const lines = judged.rows.map(
    (row) => `${row.id}\t${shown(row, row.score)}\t${row.result}`,
  );
  if (parsed.fingerprint !== fingerprint) {
    lines.push("The report was filed for another fingerprint.");
    return { pass: false, lines };
  }
  if (!judged.releasable) lines.push("A gating row is below its floor.");
  return { pass: judged.releasable, lines };
}

// Why eval.yml has no live report to compare with, as its "Read the live
// release's report" step finds it.
export const noLive = z.enum([
  "no-deploy",
  "page-unread",
  "unknown-commit",
  "predates-eval",
  "fingerprint-failed",
  "no-report",
]);
export type NoLive = z.infer<typeof noLive>;

const NO_LIVE: Record<NoLive, string> = {
  "no-deploy":
    "No deploy of main has run yet, so there is nothing to compare with.",
  "page-unread":
    "The release record on the live page could not be read, so the live release is not known and there is nothing to compare with.",
  "unknown-commit":
    "The live release's commit is not in this repository's history, so there is nothing to compare with.",
  "predates-eval":
    "The live release predates the eval's inputs, so it has no report to compare with.",
  "fingerprint-failed":
    "The live release's fingerprint could not be worked out, so its report could not be looked up. The error is in the eval job's log.",
  "no-report":
    "The live release has no report filed, so there is nothing to compare with.",
};

export function comment(ci: Report, live: Report | NoLive): string {
  const mine = verdict(ci);
  const theirs = typeof live === "string" ? null : verdict(live);
  const rows = mine.rows.map((row, i) => {
    const before = theirs?.rows[i];
    const liveScore = before === undefined ? "-" : shown(before, before.score);
    return `| ${row.measure} | ${row.on} | ${row.goIf} | ${shown(row, row.score)} | ${liveScore} | ${row.result} |`;
  });
  const liveLine =
    typeof live === "string"
      ? NO_LIVE[live]
      : `The live release's scores come from [its report's run](${live.runUrl}).`;
  return [
    MARKER,
    `### Eval: ${mine.releasable ? "go" : "no-go"}`,
    "",
    `CI's scores come from [this run](${ci.runUrl}), for fingerprint \`${ci.fingerprint.slice(0, 12)}\`. ${liveLine}`,
    "",
    "| Measure | On | Go if | This pull request | Live release | Result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ci.snapshot === null
      ? "No snapshot is pinned yet, so the gold sets are not scored."
      : `Scored on snapshot ${ci.snapshot.id}, manifest \`${ci.snapshot.manifestSha256.slice(0, 12)}\`.`,
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, path, extra, reason] = process.argv.slice(2);
  if (command === "gate" && path !== undefined && extra !== undefined) {
    const result = gate(readFileSync(path, "utf8"), extra);
    for (const line of result.lines) console.log(line);
    if (!result.pass) process.exitCode = 1;
  } else if (
    command === "comment" &&
    path !== undefined &&
    extra !== undefined
  ) {
    const read = (file: string) =>
      report.parse(JSON.parse(readFileSync(file, "utf8")));
    const live = extra === "--no-live" ? noLive.parse(reason) : read(extra);
    console.log(comment(read(path), live));
  } else {
    throw new Error(
      "usage: node evals/check.ts gate <report.json> <fingerprint> | comment <report.json> <live.json> | comment <report.json> --no-live <reason>",
    );
  }
}
