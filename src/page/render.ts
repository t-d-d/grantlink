import type { Found } from "./found.ts";

// Builds the page from the template in site/index.html and what a run
// found. The findings take the place of the not-yet-run notice, between
// the two markers. The page runs no script (docs/constraints/no-tracking.md),
// so the list is searched with the browser's own find.

const START = "<!-- found -->";
const END = "<!-- /found -->";

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
          Cn/An is the older C1234/A12345 form, An an award number alone, and
          CODE/n the newer form, such as ABCDEF-2021/100000.
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

export function buildPage(template: string, found: Found | null): string {
  const start = template.indexOf(START);
  const end = template.indexOf(END);
  if (start < 0 || end < start) {
    throw new Error("the template has no place for the findings");
  }
  if (found === null) return template;
  return (
    template.slice(0, start + START.length) +
    "\n      " +
    renderFound(found) +
    "\n      " +
    template.slice(end)
  );
}
