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

const NO_LIVE: Record<NoLive | OlderFormat, string> = {
  "older-format":
    "The live release's report is in a format this pull request's code cannot read, most likely an older one, so there is nothing to compare with.",
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

// A live report this code cannot read even leniently (#138). The comparison
// is advice, so this is a reason to show CI's scores alone, not a failure.
// It comes from check.ts, not from eval.yml, so it is not in noLive.
export type OlderFormat = "older-format";

// What the comparison reads from the live report: its run and each row's
// score. Older code may have filed it before a row or a field was added, so
// unknown keys are dropped and rows are matched by id, not position (#153).
// CI's own report and the gate keep the strict schema in report.ts.
const liveReport = z.object({
  // The link goes into the comment, so it must still be an Actions run.
  runUrl: z
    .url({ protocol: /^https$/u })
    .regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+/u),
  rows: z.array(
    z.object({ id: z.string(), score: z.number().nonnegative().nullable() }),
  ),
});
export type LiveReport = z.infer<typeof liveReport>;

// Why it could not be read goes to the job's log, as paths and codes and
// never values, so a broken report can still be told from an old one.
// stdout is the comment, so the default writes to stderr.
export function readLive(
  raw: string,
  warn: (line: string) => void = (line) => {
    console.error(line);
  },
): LiveReport | OlderFormat {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    warn("::warning::The live release's report is not JSON.");
    return "older-format";
  }
  const parsed = liveReport.safeParse(json);
  if (parsed.success) return parsed.data;
  const why = parsed.error.issues.map(
    (issue) =>
      `${issue.code} at ${issue.path.map(String).join(".") || "(root)"}${"keys" in issue ? ` (${issue.keys.join(", ")})` : ""}`,
  );
  warn(
    `::warning::The live release's report does not parse: ${why.join("; ")}.`,
  );
  return "older-format";
}

export function comment(
  ci: Report,
  live: LiveReport | NoLive | OlderFormat,
): string {
  const mine = verdict(ci);
  // The first row with an id stands, as verdict reads a report in order.
  const theirs = new Map<string, number | null>();
  if (typeof live !== "string") {
    for (const row of live.rows) {
      if (!theirs.has(row.id)) theirs.set(row.id, row.score);
    }
  }
  const rows = mine.rows.map((row) => {
    const before = theirs.get(row.id);
    const liveScore = before === undefined ? "-" : shown(row, before);
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
    // CI's own report must parse. The live one is only compared with.
    const ci = report.parse(JSON.parse(readFileSync(path, "utf8")));
    const live =
      extra === "--no-live"
        ? noLive.parse(reason)
        : readLive(readFileSync(extra, "utf8"));
    console.log(comment(ci, live));
  } else {
    throw new Error(
      "usage: node evals/check.ts gate <report.json> <fingerprint> | comment <report.json> <live.json> | comment <report.json> --no-live <reason>",
    );
  }
}
