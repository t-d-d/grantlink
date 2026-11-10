import { z } from "zod";
import { pmcid as PMCID } from "../shared/pmcid.ts";
import { storedReference } from "../store/reference.ts";
import type { PaperRow } from "../store/table.ts";

// What the page shows from a run, built from the results table. It holds a
// paper's id, title and references, and nothing else of the paper
// (docs/constraints/no-republished-text.md). The run publishes it beside the
// page as found.json, and the deploy builds the page again from it.
//
// A reference here is checked by the length and type of each field, as the
// table reads it (src/store/reference.ts), not by the characters
// referenceSchema allows (#344). A row may hold a character a later version
// allows, and a run on an older version, or a deploy that rolls back, must
// still build the page from it. The page still publishes only what a check
// passed: the version that wrote the row checked its characters against its
// own referenceSchema, and every write still does. What the page carries is
// unchanged: each paper's PMCID, title and references, each as written,
// normalised and by format, and no other field.

const title = z.string().max(500);

export const found = z
  .object({
    runId: z.string().min(1),
    finishedAt: z.iso.datetime(),
    counts: z
      .object({
        // The papers the latest complete search returned, and those of runs
        // started after it (see summarise).
        papers: z.number().int().nonnegative(),
        processed: z.number().int().nonnegative(),
        withReference: z.number().int().nonnegative(),
        references: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
      })
      .strict(),
    papers: z.array(
      z
        .object({
          pmcid: PMCID,
          title,
          references: z.array(storedReference.strict()),
        })
        .strict(),
    ),
    formats: z.array(
      z
        .object({ format: z.string(), count: z.number().int().positive() })
        .strict(),
    ),
    pending: z.array(z.object({ pmcid: PMCID, title }).strict()),
  })
  .strict();

export type Found = z.infer<typeof found>;

const byPmcid = (a: { pmcid: string }, b: { pmcid: string }) =>
  Number(a.pmcid.slice(3)) - Number(b.pmcid.slice(3));

// Each format with its count, most common first, leaving out any at none.
function mostCommonFirst(formats: Map<string, number>): Found["formats"] {
  return [...formats]
    .filter(([, count]) => count > 0)
    .map(([format, count]) => ({ format, count }))
    .sort((a, b) => b.count - a.count || a.format.localeCompare(b.format));
}

// A correction notice repeats the funding text of the paper it corrects, so
// it is no finding to show (#660). The search leaves out what Europe PMC
// marks as one, but neither the table nor found.json keeps a paper's
// publication types, so a notice found before that, or still in a
// found.json, is known by its title: a notice word followed by a colon or
// "to". "Correction of …" is a research paper's title, and stays.
const NOTICE =
  /^(?:(?:author|publisher)\s+)?(?:correction|corrigendum|erratum)(?:\s*:|\s+to\b)/iu;

export function isNotice(title: string): boolean {
  return NOTICE.test(title);
}

// The published data without any correction notice, its counts taken down
// by what goes and its formats counted again from the references that
// stay. A notice a run read and found no reference in is not in found.json,
// so only a run takes it out of the counts.
export function withoutNotices(data: Found): Found {
  const papers = data.papers.filter((paper) => !isNotice(paper.title));
  const pending = data.pending.filter((paper) => !isNotice(paper.title));
  const gone = data.papers.filter((paper) => isNotice(paper.title));
  const references = papers.flatMap((paper) => paper.references);
  const formats = new Map<string, number>();
  for (const { format } of references) {
    formats.set(format, (formats.get(format) ?? 0) + 1);
  }
  const goneWaiting = data.pending.length - pending.length;
  return found.parse({
    ...data,
    counts: {
      papers: data.counts.papers - gone.length - goneWaiting,
      processed: data.counts.processed - gone.length,
      withReference:
        data.counts.withReference -
        gone.filter((paper) => paper.references.length > 0).length,
      references:
        data.counts.references -
        gone.flatMap((paper) => paper.references).length,
      pending: data.counts.pending - goneWaiting,
    },
    papers,
    formats: mostCommonFirst(formats),
    pending,
  });
}

// Lists and counts only the papers the latest complete search returned,
// `search` being the run whose search that was, whichever run publishes.
// The search asks for papers linked to none of the funder's grants and not
// marked as retracted or as a correction notice, so a paper it left out
// has since been linked, retracted or dropped, and is no longer one the
// page is about. A paper whose title marks it as a correction notice is
// left out too, whichever search returned it. The table keeps its row. A
// row keeps the mark of the latest-started run that returned it, and run
// ids sort as their runs started, so a paper that
// search returned may carry the mark of a run that started after it. Such a run's search is newer, so its papers count too
// (#125).
export function summarise(
  all: PaperRow[],
  run: { runId: string; finishedAt: string },
  search: string = run.runId,
): Found {
  const rows = all.filter(
    (row) =>
      row.foundByRun !== undefined &&
      row.foundByRun >= search &&
      !isNotice(row.title),
  );
  const processed = rows.filter((row) => row.status === "processed");
  const papers = processed
    .filter((row) => (row.references ?? []).length > 0)
    .sort(byPmcid)
    .map((row) => ({
      pmcid: row.pmcid,
      title: row.title,
      references: (row.references ?? []).map((reference) => ({
        asWritten: reference.asWritten,
        normalised: reference.normalised,
        format: reference.format,
      })),
    }));
  const references = papers.flatMap((paper) => paper.references);
  const formats = new Map<string, number>();
  for (const reference of references) {
    formats.set(reference.format, (formats.get(reference.format) ?? 0) + 1);
  }
  const pending = rows
    .filter((row) => row.status === "pending")
    .sort(byPmcid)
    .map((row) => ({ pmcid: row.pmcid, title: row.title }));
  return found.parse({
    ...run,
    counts: {
      papers: rows.length,
      processed: processed.length,
      withReference: papers.length,
      references: references.length,
      pending: pending.length,
    },
    papers,
    formats: mostCommonFirst(formats),
    pending,
  });
}
