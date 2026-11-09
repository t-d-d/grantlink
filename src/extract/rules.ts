import { z } from "zod";
import funderFile from "./funder.json" with { type: "json" };

// The rules pass: reads grant references out of a paper's funding sections
// with patterns, before any model sees the paper. It returns references
// only, never the text around them, so nothing it returns can carry a name
// (docs/constraints/personal-data.md).

// Bump this whenever a pattern changes, so every stored result says which
// rules made it.
export const RULES_VERSION = "rules-3";

export const funder = z
  .object({
    name: z.string().min(1),
    names: z.array(z.string().min(1)).min(1),
    europePmcAgency: z.string().min(1),
    since: z.iso.date(),
  })
  .parse(funderFile);

// What the rules read: the funding and acknowledgement text, one string per
// paragraph, and the awards the paper's metadata lists with their funder.
export interface FundingSections {
  text: string[];
  awards: { source: string; ids: string[] }[];
}

export const referenceSchema = z
  .object({
    // Only the characters a reference is made of, so a name cannot pass.
    asWritten: z
      .string()
      .min(1)
      .max(48)
      .regex(/^[A-Za-z0-9 /\\∖\u2010-\u2015-]+$/u),
    normalised: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Z0-9/-]+$/u),
    format: z.string().min(1).max(20),
  })
  .strict();

export type Reference = z.infer<typeof referenceSchema>;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const NAMES = funder.names.map(escape).join("|");
const funderName = new RegExp(`(?:^|[^A-Za-z])(?:${NAMES})(?![A-Za-z])`, "iu");

// A separator may be written as a slash, a backslash or the set minus sign.
const SEP = String.raw`\s?[/\\∖]\s?`;
// A hyphen may be written as a Unicode hyphen or dash (U+2010 to U+2015).
const DASH = String.raw`[-\u2010-\u2015]`;

interface Pattern {
  format: string | ((match: RegExpMatchArray) => string);
  pattern: RegExp;
  // A short number such as an A number is common, so it counts only in a
  // sentence that names the funder.
  sentenceOnly: boolean;
}

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

const PATTERNS: Pattern[] = [
  {
    format: "Cn/An",
    pattern: new RegExp(String.raw`\bC\s?\d{1,6}${SEP}A\s?\d{4,6}\b`, "gu"),
    sentenceOnly: false,
  },
  {
    format: (match) => {
      const suffix = match[1];
      const month = match[2];
      if (month !== undefined) {
        return /\d{4}$/u.test(month) ? "CODEMonYYYY/n" : "CODEMonYY/n";
      }
      if (suffix === undefined) return "CODE/n";
      if (/^\d{4}$/u.test(suffix)) return "CODE-YYYY/n";
      if (new RegExp(`^(?:${MONTHS})\\d{2}$`, "iu").test(suffix)) {
        return "CODE-MonYY/n";
      }
      return "CODE-X/n";
    },
    // The suffix follows a hyphen, which a space may follow, or else is a
    // month in title case written straight onto the code.
    pattern: new RegExp(
      String.raw`\b[A-Z]{4,12}(?:${DASH}\s?([A-Za-z0-9]{2,8})|((?:${MONTHS})(?:\d{4}|\d{2})))?${SEP}1\d{5}\b`,
      "gu",
    ),
    sentenceOnly: false,
  },
  {
    // A G number counts only in the brackets straight after the funder's
    // name, as in "Cancer Research UK (G123/45)".
    format: "Gn/n",
    pattern: new RegExp(
      String.raw`(?<=(?:^|[^A-Za-z])(?:${NAMES})\s?\(\s?)G\d{2,4}${SEP}\d{1,4}\b`,
      "giu",
    ),
    sentenceOnly: false,
  },
  {
    // A Francis Crick Institute core funding number, old style.
    format: "FCn",
    pattern: /\bFC\s?\d{6}\b/gu,
    sentenceOnly: true,
  },
  {
    // A Francis Crick Institute core funding number, new style.
    format: "CCn",
    pattern: /\bCC\s?\d{4}\b/gu,
    sentenceOnly: true,
  },
  {
    // A joint award named for the funder, such as Stand Up To Cancer's.
    format: "RTn",
    pattern: /\bRT\s?\d{4}\b/gu,
    sentenceOnly: true,
  },
  {
    format: "An",
    pattern: /\bA\s?\d{5}\b/gu,
    sentenceOnly: true,
  },
];

function normalise(written: string): string {
  return written
    .replace(/\s+/gu, "")
    .replace(/[\\∖]/gu, "/")
    .replace(/[\u2010-\u2015]/gu, "-")
    .toUpperCase();
}

function sentences(paragraph: string): string[] {
  // A full stop after a single capital, as in U.K., does not end one.
  return paragraph.split(/(?<=(?<!\b[A-Z])[.;!?])\s+(?=[A-Z(])/u);
}

// Finds the references in one piece of text. A sentence-only pattern counts
// only where `shortNumbers` is set, and never inside a longer reference, such
// as the A part of a C/A reference.
interface Found extends Reference {
  sentenceOnly: boolean;
}

function scan(text: string, shortNumbers: boolean): Found[] {
  const found: Found[] = [];
  const taken: [number, number][] = [];
  for (const { format, pattern, sentenceOnly } of PATTERNS) {
    if (sentenceOnly && !shortNumbers) continue;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (taken.some(([from, to]) => start < to && end > from)) continue;
      taken.push([start, end]);
      found.push({
        asWritten: match[0],
        normalised: normalise(match[0]),
        format: typeof format === "string" ? format : format(match),
        sentenceOnly,
      });
    }
  }
  return found;
}

// A bare number is common in any text, so it counts only when the metadata
// gives it to the funder as a whole award id and the paper's own funding or
// acknowledgement text gives the same number, standing alone (#97). A number
// joined to a letter, a digit or a separator is part of a longer reference.
const BARE_NUMBER = /^\d{5,7}$/u;

function confirmedNumber(id: string, text: readonly string[]): boolean {
  if (!BARE_NUMBER.test(id)) return false;
  const alone = new RegExp(
    `(?<![A-Za-z0-9]|${SEP})${id}(?![A-Za-z0-9]|${SEP})`,
    "u",
  );
  return text.some((paragraph) => alone.test(paragraph));
}

// Whether a reference already found gives this number, with its A or as the
// last part of a longer reference, so the number alone would list it twice.
function alreadyFound(id: string, found: readonly Reference[]): boolean {
  return found.some(
    ({ normalised }) =>
      normalised === `A${id}` ||
      normalised.endsWith(`/A${id}`) ||
      normalised.endsWith(`/${id}`),
  );
}

const reference = ({ asWritten, normalised, format }: Found): Reference => ({
  asWritten,
  normalised,
  format,
});

export function findReferences(sections: FundingSections): Reference[] {
  const found: Reference[] = [];
  for (const paragraph of sections.text) {
    if (!funderName.test(paragraph)) continue;
    found.push(...scan(paragraph, false).map(reference));
    for (const sentence of sentences(paragraph)) {
      if (!funderName.test(sentence)) continue;
      found.push(
        ...scan(sentence, true)
          .filter(({ sentenceOnly }) => sentenceOnly)
          .map(reference),
      );
    }
  }
  for (const award of sections.awards) {
    if (!funderName.test(award.source)) continue;
    for (const id of award.ids) {
      const trimmed = id.trim();
      if (!confirmedNumber(trimmed, sections.text)) {
        found.push(...scan(trimmed, true).map(reference));
      } else if (!alreadyFound(trimmed, found)) {
        found.push({ asWritten: trimmed, normalised: trimmed, format: "n" });
      }
    }
  }
  const seen = new Set<string>();
  return found.filter((reference) => {
    if (seen.has(reference.normalised)) return false;
    seen.add(reference.normalised);
    return true;
  });
}
