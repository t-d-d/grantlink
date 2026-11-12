import { normalise } from "../../src/extract/rules.ts";
import { sample } from "../../src/pipeline/snapshot.ts";

// Which of gold set B2's rows the owner checks (#695, #700). Two passes of
// Claude Opus propose each paper's labels. The rules and each model the eval
// compares alone then read the paper's funding sections. A row is flagged
// for every reason the owner checks it, and 10 of the rows with no reason
// are drawn at random with a recorded seed. A flag says only that a row
// differs, never which reference, so the check reads the paper afresh.
// Everything here is ids, labels and references, never a paper's text
// (docs/constraints/personal-data.md).

export type Funded = "yes" | "no" | "unclear";

// One pass's labels for one paper, references normalised.
export interface Pass {
  funded: Funded;
  references: readonly string[];
  unsure: boolean;
}

export interface Readings {
  passes: readonly [Pass, Pass];
  // The rules' references, normalised.
  rules: readonly string[];
  // Each model's references alone, normalised, by model id.
  models: Readonly<Record<string, readonly string[]>>;
}

export const NOT_CHECKED = "agreed, not checked";
export const SAMPLED = "sample";
export const SAMPLE_SIZE = 10;

// The guide's normal form (docs/gold-set-b-guide.md): the rules' own, and a
// CRUK printed straight onto the front of a reference dropped. A reference
// whose own form starts CRUK/ or CRUK- keeps it.
// The test reads the reference as written, since normalising takes out the
// space that keeps a CRUK apart from it.
export function guideNormalise(written: string): string {
  const form = normalise(written);
  return /^CRUK[A-Z0-9]/iu.test(written.trim()) ? form.slice(4) : form;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((x) => right.has(x));
};

// The sheet's `passes` column, as for gold set B, with the references
// named too, since gold set B2's passes may differ on them.
export function passesFor([one, two]: readonly [Pass, Pass]): string {
  const said = [
    ...(one.funded === two.funded ? [] : ["passes differed on funded"]),
    ...(sameSet(one.references, two.references)
      ? []
      : ["passes differed on references"]),
    ...(one.unsure || two.unsure ? ["a pass was unsure"] : []),
  ];
  return said.length === 0 ? "passes agreed" : said.join("; ");
}

// Every reason the owner checks a row, in the order #700 lists them.
export function flagsFor(
  proposed: readonly string[],
  { passes: [one, two], rules, models }: Readings,
): string[] {
  const differ =
    one.funded !== two.funded || !sameSet(one.references, two.references);
  return [
    ...(differ ? ["passes differ"] : []),
    ...(one.unsure || two.unsure ? ["a pass was unsure"] : []),
    ...(sameSet(proposed, rules) ? [] : ["differs from the rules"]),
    ...Object.entries(models)
      .filter(([, found]) => !sameSet(proposed, found))
      .map(([model]) => `differs from ${model} alone`),
  ];
}

// The rows the owner checks though nothing flagged them: `size` of the rows
// with no reason, drawn with the seed as gold set B2's own sample is.
export function agreedSample(
  rows: readonly { pmcid: string; reasons: readonly string[] }[],
  seed: number,
  size: number = SAMPLE_SIZE,
): string[] {
  const pool = rows
    .filter(({ reasons }) => reasons.length === 0)
    .map(({ pmcid }) => pmcid);
  return sample(pool, seed).slice(0, size);
}

const cell = (value: string): string =>
  /[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export function csv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => `${row.map(cell).join(",")}\n`).join("");
}

// Reads what csv() writes: quoted cells, with a doubled quote for a quote.
// It reads a spreadsheet's export too, whose lines end CRLF and which may
// start with a byte order mark.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = text.startsWith("\uFEFF") ? 1 : 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (quoted) {
      if (char === '"' && text.charAt(i + 1) === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\r" && text.charAt(i + 1) === "\n") {
      // The \n that follows ends the row.
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  if (value !== "" || row.length > 0) rows.push([...row, value]);
  return rows;
}
