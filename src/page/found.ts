import { z } from "zod";
import { referenceSchema } from "../extract/rules.ts";
import { pmcid as PMCID } from "../shared/pmcid.ts";
import type { PaperRow } from "../store/table.ts";

// What the page shows from a run, built from the results table. It holds a
// paper's id, title and references, and nothing else of the paper
// (docs/constraints/no-republished-text.md). The run publishes it beside the
// page as found.json, and the deploy builds the page again from it.

const title = z.string().max(500);

export const found = z
  .object({
    runId: z.string().min(1),
    finishedAt: z.iso.datetime(),
    counts: z
      .object({
        // Every paper the run's search found.
        papers: z.number().int().nonnegative(),
        processed: z.number().int().nonnegative(),
        withReference: z.number().int().nonnegative(),
        references: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
      })
      .strict(),
    papers: z.array(
      z
        .object({ pmcid: PMCID, title, references: z.array(referenceSchema) })
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

// Lists and counts only the papers the latest complete search returned,
// `search` being the run whose search that was, whichever run publishes.
// The search asks for papers linked to none of the funder's grants, so a
// paper it left out has since been linked, or dropped, and is no longer one
// the page is about. The table keeps its row. A row keeps the mark of the
// latest-started run that returned it, and run ids sort as their runs
// started, so a paper that search returned may carry the mark of a run that
// started after it. Such a run's search is newer, so its papers count too
// (#125).
export function summarise(
  all: PaperRow[],
  run: { runId: string; finishedAt: string },
  search: string = run.runId,
): Found {
  const rows = all.filter(
    (row) => row.foundByRun !== undefined && row.foundByRun >= search,
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
    formats: [...formats]
      .map(([format, count]) => ({ format, count }))
      .sort((a, b) => b.count - a.count || a.format.localeCompare(b.format)),
    pending,
  });
}
