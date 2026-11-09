import { shownScore } from "../../evals/floors.ts";
import { verdict } from "../../evals/report.ts";
import type { Found } from "./found.ts";
import type { Release } from "./release.ts";

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

const number = (n: number) => n.toLocaleString("en-GB");

const paperLink = (paper: { pmcid: string; title: string }) =>
  `<a href="https://europepmc.org/article/PMC/${escape(paper.pmcid)}">${escape(
    paper.title === "" ? paper.pmcid : paper.title,
  )}</a>`;

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
      "papers found that name Cancer Research UK but are linked to none of its grants",
    ],
    [counts.processed, "papers read"],
    [counts.withReference, "papers that give a grant reference"],
    [counts.references, "grant references recovered"],
    [counts.pending, "papers not yet read"],
  ];
  const rows = found.papers.flatMap((paper) =>
    paper.references.map(
      (reference) =>
        `<tr><td class="paper">${paperLink(paper)}</td><td class="ref">${escape(
          reference.asWritten,
        )}</td><td class="ref">${escape(reference.normalised)}</td><td class="status">Proposed by software</td></tr>`,
    ),
  );
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
            <tr><th scope="col">Paper</th><th scope="col">Reference as written</th><th scope="col">Normalised</th><th scope="col">Status</th></tr>
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
          CODE/n the newer form, such as ABCDEF-2021/100000, and n a bare award
          number that both the paper's metadata and its funding text give.
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

// How it's run: the go/no-go table for the live release beside the rules
// alone, the runs that deployed and scored it, and the snapshot it was
// scored on (docs/constraints/deploy-gates.md).
export function renderRun(release: Release): string {
  const { report } = release;
  const cell = (text: string, cls = "") =>
    `<td${cls === "" ? "" : ` class="${cls}"`}>${escape(text)}</td>`;
  const rows = verdict(report).rows.map(
    (row) =>
      `<tr>${[
        cell(row.measure),
        cell(row.on),
        cell(row.goIf),
        cell(GATES[row.gates] ?? row.gates),
        cell(shownScore(row.id, row.score), "count"),
        cell(shownScore(row.id, row.baseline), "count"),
        cell(row.result, "status"),
      ].join("")}</tr>`,
  );
  const snapshot =
    report.snapshot === null
      ? "No eval snapshot is pinned yet, so the gold sets are not scored, and each row that needs them waits without blocking."
      : `Scored on eval snapshot ${escape(report.snapshot.id)}, whose manifest has the SHA-256 <code class="ref">${escape(
          report.snapshot.manifestSha256,
        )}</code>.`;
  return `<section aria-labelledby="run">
        <h2 id="run">How it's run</h2>
        <p>
          Every release is gated by an evaluation, and only a green merge to
          main deploys. The live release is commit
          <code class="ref">${escape(release.commit.slice(0, 7))}</code>,
          deployed by <a href="${escape(release.deployRunUrl)}">this run</a>.
          Its scores come from <a href="${escape(report.runUrl)}">the run that
          filed its eval report</a>, with model ${escape(report.modelId)}.
        </p>
        <div class="table-scroll">
          <table class="go-no-go">
            <tr><th scope="col">Measure</th><th scope="col">On</th><th scope="col">Go if</th><th scope="col">Gates a release</th><th scope="col">This release</th><th scope="col">Rules alone</th><th scope="col">Result</th></tr>
            ${rows.join("\n            ")}
          </table>
        </div>
        <p class="note">${snapshot}</p>
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
