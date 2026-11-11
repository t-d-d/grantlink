import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { FLOORS, judge, shownScore, type RowId } from "./floors.ts";
import {
  readAlone,
  report,
  verdict,
  type Judged,
  type Report,
} from "./report.ts";

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

// A model alone's cell on a gold set it read no paper of (#696).
const NONE_READ = "none read" as const;

// How many papers of a gold set the rules were scored on.
const sentOn = (ci: Report, id: RowId): number =>
  ci.baseline.find((row) => row.id === id)?.n ?? 0;

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
export const noLive = z.enum(["no-deploy", "page-unread"]);
export type NoLive = z.infer<typeof noLive>;

const NO_LIVE: Record<NoLive | Unreadable, string> = {
  unreadable:
    "The live release's report is in a format this pull request's code cannot read, so there is nothing to compare with. The eval job's log says why.",
  "no-deploy":
    "No deploy of main has run yet, so there is nothing to compare with.",
  "page-unread":
    "The release record on the live page could not be read, or holds no report, so there is nothing to compare with.",
};

// A live report this code cannot read even leniently (#138). The comparison
// is advice, so this is a reason to show CI's scores alone, not a failure.
// It comes from check.ts, not from eval.yml, so it is not in noLive.
export type Unreadable = "unreadable";

// What the comparison reads from the live report: its run, its snapshot's
// id and each row's score. Older code may have filed it before a row or a
// field was added, so unknown keys are dropped and rows are matched by id,
// not position (#153).
// CI's own report and the gate keep the strict schema in report.ts.
// A report that shares no row with this code has nothing to compare, so it
// reads as one this code cannot read.
// Newer code may file a row this code does not know, with a score of
// another shape. It is never compared, so it is dropped unread. A
// malformed row this code knows still fails the report, so a broken report
// is not shown as a partial one (#169).
const known = new Set<string>(FLOORS.map((floor) => floor.id));
const liveRow = z.object({
  id: z.string(),
  score: z.number().nonnegative().nullable(),
});
const knownId = (item: unknown): boolean =>
  typeof item === "object" &&
  item !== null &&
  "id" in item &&
  typeof item.id === "string" &&
  known.has(item.id);
const liveReport = z.object({
  // The link goes into the comment, so it must still be an Actions run.
  runUrl: report.shape.runUrl,
  // Scores compare only on the same snapshot (#232), so its id is kept to
  // say when they do not. A report from before there was one reads as null.
  // The id goes into the comment too, so it keeps the strict bounds.
  snapshot: z
    .object({ id: report.shape.snapshot.unwrap().shape.id })
    .nullish()
    .transform((snapshot) => snapshot?.id ?? null),
  rows: z.array(z.unknown()).transform((list, ctx) => {
    const kept: z.infer<typeof liveRow>[] = [];
    list.forEach((item, index) => {
      if (!knownId(item)) return;
      const parsed = liveRow.safeParse(item);
      if (parsed.success) kept.push(parsed.data);
      else {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [index, ...issue.path] });
        }
      }
    });
    if (kept.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a live report shares a row with this code",
      });
    }
    return kept;
  }),
});
export type LiveReport = z.infer<typeof liveReport>;

// Why it could not be read goes to the job's log, as paths and codes and
// never values, so the comment need not guess the cause (#186).
// stdout is the comment, so the default writes to stderr.
export function readLive(
  raw: string,
  warn: (line: string) => void = (line) => {
    console.error(line);
  },
): LiveReport | Unreadable {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    warn("::warning::The live release's report is not JSON.");
    return "unreadable";
  }
  const parsed = liveReport.safeParse(json);
  if (parsed.success) return parsed.data;
  const why = parsed.error.issues.map(
    (issue) =>
      `${issue.code} at ${issue.path.map(String).join(".") || "(root)"}`,
  );
  warn(
    `::warning::The live release's report does not parse: ${why.join("; ")}.`,
  );
  return "unreadable";
}

export function comment(
  ci: Report,
  live: LiveReport | NoLive | Unreadable,
): string {
  const mine = verdict(ci);
  // The lenient schema lets an id repeat. The first row with it stands.
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
  const named = (id: string | null): string =>
    id === null ? "no snapshot" : `snapshot ${id}`;
  const ours = ci.snapshot?.id ?? null;
  // Above the table, so it is read before the scores it qualifies.
  const otherSnapshot =
    typeof live === "string" || live.snapshot === ours
      ? []
      : [
          "",
          `The live release was scored on ${named(live.snapshot)} and this pull request on ${named(ours)}, so their scores do not compare.`,
        ];
  return [
    MARKER,
    `### Eval: ${mine.releasable ? "go" : "no-go"}`,
    "",
    `CI's scores come from [this run](${ci.runUrl}), for fingerprint \`${ci.fingerprint.slice(0, 12)}\`. ${liveLine}`,
    ...otherSnapshot,
    "",
    "| Measure | On | Go if | This pull request | Live release | Result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ci.snapshot === null
      ? "No snapshot is pinned yet, so the gold sets are not scored."
      : `Scored on snapshot ${ci.snapshot.id}, manifest \`${ci.snapshot.manifestSha256.slice(0, 12)}\`.`,
    ...models(ci),
    ...heldOutA2(ci),
  ].join("\n");
}

// Gold set A2's recall beside gold set A's, for the rules alone, each model
// alone and the rules then each model (#695). It gates nothing, and lists
// no misses. A report filed before gold set A2 joined shows no table.
function heldOutA2(ci: Report): string[] {
  const a2 = ci.goldA2;
  if (a2 === undefined) return [];
  const cell = (score: number | null | typeof NONE_READ) =>
    score === NONE_READ
      ? score
      : score === null
        ? judge("recall-a", null)
        : shownScore("recall-a", score);
  const recallA = (rows: Report["rows"] | undefined) =>
    rows?.find((row) => row.id === "recall-a")?.score ?? null;
  // A gold set with no papers waits for its snapshot, so only a scored
  // one can have none read.
  const scoredA = sentOn(ci, "recall-a") > 0;
  const columns = a2.models.flatMap((model) => {
    const candidate = (ci.candidates ?? []).find(
      (c) => c.modelId === model.modelId,
    );
    return [
      {
        name: `${model.modelId} alone`,
        a:
          scoredA && candidate?.read?.goldA === 0
            ? NONE_READ
            : recallA(candidate?.alone),
        a2: a2.rules.n > 0 && model.read === 0 ? NONE_READ : model.alone.score,
      },
      {
        name: `Rules then ${model.modelId}`,
        a: recallA(candidate?.rows),
        a2: model.rulesThen.score,
      },
    ];
  });
  const line = (
    on: string,
    rules: number | null,
    scores: (number | null | typeof NONE_READ)[],
  ) => `| ${[on, cell(rules), ...scores.map(cell)].join(" | ")} |`;
  const names = ["On", "Rules alone", ...columns.map((c) => c.name)];
  return [
    "",
    "#### Recall on gold set A and held-out gold set A2",
    "",
    `| ${names.join(" | ")} |`,
    `| ${names.map(() => "---").join(" | ")} |`,
    line(
      "Gold set A",
      recallA(ci.baseline),
      columns.map((c) => c.a),
    ),
    line(
      "Gold set A2, held out",
      a2.rules.score,
      columns.map((c) => c.a2),
    ),
    "",
    "Gold set A2 is drawn as gold set A is, with its own seed, from papers not in gold set A. Nobody tuned the rules or the prompt on gold set A2. Gold set A2 gates nothing.",
    // A report filed before #696 counted an unread paper as missed alone.
    ...a2.models
      .filter((model) => model.unprocessed > 0)
      .map((model) => {
        const left = `${model.modelId} left ${String(model.unprocessed)} gold set A2 ${model.unprocessed === 1 ? "paper" : "papers"} unread`;
        return model.read === undefined
          ? `${left}, and they count as missed.`
          : `${left}. They are out of its recall alone, and score what the rules found after the rules.`;
      }),
  ];
}

// The rules alone beside each model alone and the rules then each model
// (#329, #694). They do not gate: rules ship alone (#330), and the eval
// scores each model to show what it would add. A row with no score says
// what it waits for. A model alone adds nothing after the rules, so that
// cell is a dash. A report filed before the eval scored a model alone gives
// that model one column, the rules then the model.
function models(ci: Report): string[] {
  const candidates = ci.candidates ?? [];
  if (candidates.length === 0) return [];
  const cell = (id: (typeof FLOORS)[number]["id"], score: number | null) =>
    score === null ? judge(id, null) : shownScore(id, score);
  const scoreIn = (rows: Report["rows"], i: number) => rows[i]?.score ?? null;
  const columns = candidates.flatMap((c) =>
    c.alone === undefined
      ? [{ name: c.modelId, rows: c.rows, alone: false, read: undefined }]
      : [
          {
            name: `${c.modelId} alone`,
            rows: c.alone,
            alone: true,
            read: c.read,
          },
          {
            name: `Rules then ${c.modelId}`,
            rows: c.rows,
            alone: false,
            read: undefined,
          },
        ],
  );
  // A model alone that read no paper of a scored gold set has no score on
  // it (#696). A gold set with no papers waits for its snapshot.
  const scoredA = sentOn(ci, "recall-a") > 0;
  const scoredB = sentOn(ci, "recall-b") > 0;
  const noneRead = (
    read: { goldA: number; goldB: number } | undefined,
    id: RowId,
  ): boolean =>
    read !== undefined &&
    (id === "recall-a"
      ? scoredA && read.goldA === 0
      : (id === "precision-b" || id === "recall-b") &&
        scoredB &&
        read.goldB === 0);
  const rows = FLOORS.map((floor, i) =>
    [
      floor.measure,
      floor.on,
      cell(floor.id, scoreIn(ci.baseline, i)),
      ...columns.map((column) =>
        column.alone && floor.id === "model-adds"
          ? "-"
          : column.alone && noneRead(column.read, floor.id)
            ? NONE_READ
            : cell(floor.id, scoreIn(column.rows, i)),
      ),
    ].join(" | "),
  );
  const read = readAlone(ci);
  const left = candidates
    .filter((c) => c.unprocessed.length > 0)
    .map(
      (c) =>
        `${c.modelId} left ${String(c.unprocessed.length)} ${c.unprocessed.length === 1 ? "paper" : "papers"} for the next run: ${c.unprocessed.join(", ")}.`,
    );
  return [
    "",
    columns.some((column) => column.alone)
      ? "#### The rules alone, each model alone, and the rules then each model"
      : "#### The rules alone and with each model",
    "",
    `| Measure | On | Rules alone | ${columns.map((c) => c.name).join(" | ")} |`,
    `| --- | --- | --- | ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row} |`),
    ...(left.length === 0 ? [] : ["", ...left]),
    ...(read.length === 0 ? [] : ["", ...read]),
  ];
}

// The comment command's arguments after "comment" (#154). The first names
// CI's own report, which must parse, so a bad one throws and fails the eval
// check. The second names the live one, which is only compared with, so a
// bad one shows CI's scores alone. read takes a path and gives its contents.
export function commentFrom(
  [path, extra, reason]: readonly (string | undefined)[],
  read: (path: string) => string,
  warn?: (line: string) => void,
): string {
  if (path === undefined || extra === undefined) throw new Error(USAGE);
  const ci = report.parse(JSON.parse(read(path)));
  return comment(
    ci,
    extra === "--no-live" ? noLive.parse(reason) : readLive(read(extra), warn),
  );
}

const USAGE =
  "usage: node evals/check.ts gate <report.json> <fingerprint> | comment <report.json> <live.json> | comment <report.json> --no-live <reason>";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const [path, extra] = args;
  if (command === "gate" && path !== undefined && extra !== undefined) {
    const result = gate(readFileSync(path, "utf8"), extra);
    for (const line of result.lines) console.log(line);
    if (!result.pass) process.exitCode = 1;
  } else if (command === "comment") {
    console.log(commentFrom(args, (file) => readFileSync(file, "utf8")));
  } else {
    throw new Error(USAGE);
  }
}
