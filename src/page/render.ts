import { shownScore, type RowId } from "../../evals/floors.ts";
import { RULES_ALONE, verdict, type Report } from "../../evals/report.ts";
import type { Found } from "./found.ts";
import type { Release } from "./release.ts";
import { paired, titleParts } from "../title.ts";

// Builds the page from the template in site/index.html and what a run
// found. The findings take the place of the not-yet-run notice, between
// the two markers. The page runs no script (docs/constraints/no-tracking.md),
// so the list is searched with the browser's own find.

const START = "<!-- found -->";
const END = "<!-- /found -->";
const RUN_START = "<!-- run -->";
const RUN_END = "<!-- /run -->";

const escape = (text: string) =>
  text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");

type Reference = Found["papers"][number]["references"][number];

// Europe PMC's titles may carry a little inline markup, such as the
// <sup>18</sup> of [18F] (#606). Those few tags are shown as formatting,
// when they carry no attribute, and everything else in a title is escaped.
// src/title.ts reads the tags and pairs them, so a title's markup never
// reaches past the title (#639).
const titleHtml = (title: string) =>
  paired(titleParts(title))
    .map((part) => ("tag" in part ? part.tag : escape(part.text)))
    .join("");

const number = (n: number) => n.toLocaleString("en-GB");

// A title whose markup leaves no text would give a link with no name, so it
// is linked by its pmcid, as an empty title is. Its escaped text holds no
// "<", so only the tags titleHtml writes are taken out.
const paperLink = (paper: { pmcid: string; title: string }) => {
  const title = titleHtml(paper.title);
  const shown =
    title.replace(/<[^>]*>/gu, "").trim() === "" ? escape(paper.pmcid) : title;
  return `<a href="https://europepmc.org/article/PMC/${escape(paper.pmcid)}">${shown}</a>`;
};

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/London",
});

export function renderFound(found: Found): string {
  const { counts } = found;
  const cards: [number, string][] = [
    [
      counts.papers,
      "papers that name Cancer Research UK as a funder but are not yet linked to one of its grants in Europe PMC",
    ],
    [counts.processed, "papers read"],
    [counts.withReference, "papers that give a grant reference"],
    [counts.references, "grant references recovered"],
    [counts.pending, "papers not yet read"],
  ];
  // One row per paper, so a paper with two references is listed once
  // (#587). Each cell holds one line per reference, in the same order, and
  // each reference keeps its own status (accuracy.md). A paper with no
  // reference has no link to show, so it gets no row. A reference is shown
  // in its normal form, as gold set B stores it, with no stray space and the
  // usual slash and hyphen. found.json keeps it as the paper printed it
  // (#606).
  const rows = found.papers
    .filter((paper) => paper.references.length > 0)
    .map((paper) => {
      const lines = (text: (reference: Reference) => string) =>
        paper.references.map(text).join("<br>");
      return `<tr><td class="paper">${paperLink(paper)}</td><td class="ref">${lines(
        (reference) => escape(reference.normalised),
      )}</td><td class="status">${lines(() => "Proposed by software")}</td></tr>`;
    });
  const formats = found.formats.map(
    (format) =>
      `<tr><td class="ref">${escape(format.format)}</td><td class="count">${number(
        format.count,
      )}</td></tr>`,
  );
  const pending = found.pending.map((paper) => `<li>${paperLink(paper)}</li>`);
  return `<section aria-labelledby="found">
        <h2 id="found">What it found</h2>
        <p class="updated">
          From the run that finished on
          <time datetime="${escape(found.finishedAt)}">${DATE.format(new Date(found.finishedAt))}</time>.
        </p>
        <div class="cards">
${cards.map(([n, label]) => `          <p class="card stat"><span class="value">${number(n)}</span> ${escape(label)}</p>`).join("\n")}
        </div>

        <h3>Recovered references</h3>
        <p>
          These links are proposed by software. No person has checked them
          yet, and they come with no warranty. Each title opens the paper on
          Europe PMC, where the reference is in its funding text. Search the
          list with your browser's find.
        </p>
        <div class="table-scroll">
          <table class="references">
            <tr><th scope="col">Paper</th><th scope="col">Grant reference</th><th scope="col">Status</th></tr>
            ${rows.join("\n            ")}
          </table>
        </div>

        <h3>Reference formats</h3>
        <div class="table-scroll">
          <table class="formats">
            <tr><th scope="col">Format</th><th scope="col">References</th></tr>
            ${formats.join("\n            ")}
          </table>
        </div>
        <p class="note">
          Cn/An is the older C1234/A12345 form, An an award number alone,
          CODE/n the newer form, such as ABCDEF-2021/100000,
          CRUK-X a form that carries the funder's short name, such as
          CRUK/12/034,
          and n a bare award number that the funding text ties to the funder,
          or that both the paper's metadata and its funding text give.
        </p>

        <h3>Not yet read</h3>
        <p>
          A paper whose full text could not be read this time is tried again on
          the next run.
        </p>
        <details>
          <summary>${number(found.pending.length)} papers</summary>
          <ul class="pending">
            ${pending.join("\n            ")}
          </ul>
        </details>
      </section>`;
}

const GATES: Record<string, string> = {
  yes: "Yes",
  reported: "No, reported",
  "decides the model": "No, it decides the model",
};

const GOLD_B_LABELS = [
  "Gold set B's labels were proposed by two passes of a Claude model and checked by the owner against a written guide.",
  "The owner checked 58 of the 100 papers: every one where the passes differed or one was unsure, the 18 used to settle the guide's rules, and 10 of the rest drawn at random.",
  "That sample found no error, so the other 42 were accepted as proposed.",
  "The owner changed none of the labels.",
  "Because a Claude model proposed them, the labels may favour a model over the rules, so read what each model scores alone, and what it adds after the rules, with that in mind.",
  '<a href="https://github.com/t-d-d/grantlink/issues/175">The decision record</a> says why.',
].join(" ");

const SHIPS_ALONE = "Rules ship alone";

// Rules ship alone (#330), so the release calls no model. Beside the table,
// the page gives what each model the eval scored would add, and its spend,
// or nothing when the eval scored none.
function rulesAloneNote(report: Report): string {
  const scoreOf = (rows: Report["rows"], id: string) =>
    rows.find((row) => row.id === id)?.score ?? null;
  const models = (report.candidates ?? []).flatMap((candidate) => {
    const adds = scoreOf(candidate.rows, "model-adds");
    if (adds === null) return [];
    const spend = scoreOf(candidate.rows, "spend");
    const cost =
      spend === null
        ? ""
        : `, for ${shownScore("spend", spend)} per 1,000 papers`;
    return [
      `<code class="ref">${escape(candidate.modelId)}</code> adds ${shownScore("model-adds", adds)} of recall on gold set B${cost}.`,
    ];
  });
  if (models.length === 0) return aloneTable(report);
  return `\n        <p class="note">${[
    `${SHIPS_ALONE}. The eval still scores each model after the rules, on the same papers.`,
    ...models,
    "A model ships only if it adds at least 10 points.",
    '<a href="https://github.com/t-d-d/grantlink/issues/330">The decision</a> says why.',
  ].join(" ")}</p>${aloneTable(report)}`;
}

// Each model's precision and recall on gold set B alone, beside the rules
// alone and what the model adds after them (#694). It does not gate. A
// report filed before the eval scored a model alone shows no table.
function aloneTable(report: Report): string {
  const scoreOf = (rows: Report["rows"], id: string) =>
    rows.find((row) => row.id === id)?.score ?? null;
  const count = (id: RowId, score: number | null) =>
    `<td class="count">${escape(shownScore(id, score))}</td>`;
  const line = (name: string, rows: Report["rows"], adds: number | null) =>
    `<tr><th scope="row">${name}</th>${count("precision-b", scoreOf(rows, "precision-b"))}${count("recall-b", scoreOf(rows, "recall-b"))}${count("model-adds", adds)}</tr>`;
  const models = (report.candidates ?? []).flatMap((candidate) =>
    candidate.alone === undefined
      ? []
      : [
          line(
            `<code class="ref">${escape(candidate.modelId)}</code> alone`,
            candidate.alone,
            scoreOf(candidate.rows, "model-adds"),
          ),
        ],
  );
  if (models.length === 0) return "";
  return `
        <p class="note">The eval also scores each model alone, on the same papers and from the same replies. Nothing gates on a model alone.</p>
        <div class="table-scroll">
          <table class="models">
            <tr><th scope="col">Read by</th><th scope="col">Precision on gold set B</th><th scope="col">Recall on gold set B</th><th scope="col">Adds after the rules</th></tr>
            ${[line("Rules alone", report.baseline, null), ...models].join("\n            ")}
          </table>
        </div>`;
}

// How it's run: the go/no-go table for the live release beside the rules
// alone, the runs that deployed and scored it, and the snapshot it was
// scored on (docs/constraints/deploy-gates.md).
export function renderRun(release: Release): string {
  const { report } = release;
  const alone = report.modelId === RULES_ALONE;
  const cell = (text: string, cls = "") =>
    `<td${cls === "" ? "" : ` class="${cls}"`}>${escape(text)}</td>`;
  const judged = verdict(report).rows;
  const rows = judged.map(
    (row) =>
      `<tr>${[
        cell(row.measure),
        cell(row.on),
        cell(row.goIf),
        cell(GATES[row.gates] ?? row.gates),
        cell(shownScore(row.id, row.score), "count"),
        cell(shownScore(row.id, row.baseline), "count"),
        cell(
          alone && row.id === "model-adds" ? SHIPS_ALONE : row.result,
          "status",
        ),
      ].join("")}</tr>`,
  );
  const model = alone
    ? ". This release reads references with the rules alone and calls no model"
    : `, with model ${escape(report.modelId)}`;
  const snapshot =
    report.snapshot === null
      ? "No eval snapshot is pinned yet, so the gold sets are not scored, and each row that needs them waits without blocking."
      : `Scored on eval snapshot ${escape(report.snapshot.id)}, whose manifest has the SHA-256 <code class="ref">${escape(
          report.snapshot.manifestSha256,
        )}</code>.`;
  // A model proposed gold set B's labels (#175), so wherever its rows have
  // scores the page says how the labels were made.
  const goldB = judged.some(
    (row) => row.on === "Gold set B" && row.score !== null,
  )
    ? `\n        <p class="note">${GOLD_B_LABELS}</p>`
    : "";
  return `<section aria-labelledby="run">
        <h2 id="run">How it's run</h2>
        <p>
          Every release is gated by an evaluation, and only a green merge to
          main deploys. The live release is commit
          <code class="ref">${escape(release.commit.slice(0, 7))}</code>,
          deployed by <a href="${escape(release.deployRunUrl)}">this run</a>.
          Its scores come from <a href="${escape(report.runUrl)}">the run that
          filed its eval report</a>${model}.
        </p>
        <div class="table-scroll">
          <table class="go-no-go">
            <tr><th scope="col">Measure</th><th scope="col">On</th><th scope="col">Go if</th><th scope="col">Gates a release</th><th scope="col">This release</th><th scope="col">Rules alone</th><th scope="col">Result</th></tr>
            ${rows.join("\n            ")}
          </table>
        </div>${alone ? rulesAloneNote(report) : ""}
        <p class="note">${snapshot}</p>${goldB}
      </section>`;
}

function replaceBetween(
  page: string,
  start: string,
  end: string,
  content: string,
): string {
  const from = page.indexOf(start);
  return (
    page.slice(0, from + start.length) +
    "\n      " +
    content +
    "\n      " +
    page.slice(page.indexOf(end))
  );
}

export function buildPage(
  template: string,
  found: Found | null,
  release: Release | null = null,
): string {
  for (const [start, end] of [
    [START, END],
    [RUN_START, RUN_END],
  ] as const) {
    const from = template.indexOf(start);
    if (from < 0 || template.indexOf(end) < from) {
      throw new Error(`the template has no place between ${start} and ${end}`);
    }
  }
  let page = template;
  if (found !== null) {
    page = replaceBetween(page, START, END, renderFound(found));
  }
  if (release !== null) {
    page = replaceBetween(page, RUN_START, RUN_END, renderRun(release));
  }
  return page;
}
