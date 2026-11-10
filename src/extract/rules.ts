import { z } from "zod";
import funderFile from "./funder.json" with { type: "json" };

// The rules pass: reads grant references out of a paper's funding sections
// with patterns, before any model sees the paper. It returns references
// only, never the text around them, so nothing it returns can carry a name
// (docs/constraints/personal-data.md).

// Bump this whenever a pattern, or which references the rules keep,
// changes, so every stored result says which rules made it.
export const RULES_VERSION = "rules-9";

export const funder = z
  .object({
    name: z.string().min(1),
    names: z.array(z.string().min(1)).min(1),
    europePmcAgency: z.string().min(1),
    since: z.iso.date(),
  })
  .parse(funderFile);

// What the rules read: the funding and acknowledgement text, one string per
// paragraph, and the awards the paper's metadata lists with their funders.
// An award lists more than one source when its metadata names several
// funders and does not say whose its ids are (#128).
export interface FundingSections {
  text: string[];
  awards: { sources: string[]; ids: string[] }[];
}

// A hyphen, in a name or a reference, may be written as a Unicode hyphen or
// dash (U+2010 to U+2015) (#201) or as the minus sign (U+2212) (#269).
const DASHES = `${String.fromCodePoint(0x2010)}-${String.fromCodePoint(0x2015)}${String.fromCodePoint(0x2212)}`;

export const referenceSchema = z
  .object({
    // Only the characters a reference is made of, so a name cannot pass.
    asWritten: z
      .string()
      .min(1)
      .max(48)
      .regex(new RegExp(`^[A-Za-z0-9 /\\\\∖${DASHES}-]+$`, "u")),
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
const DASH = `[-${DASHES}]`;
// A letter as a class of its upper and lower case, for a pattern whose own
// letters must keep their case and so cannot take the `i` flag. Any letter
// folds, not only A to Z (#301). A case that is more than one character, as
// "SS" is for "ß", is left out of the class. The `i` flag also folds a few
// letters with no upper and lower case pair, such as "ς" with "σ" and "ſ"
// with "s", which this does not (#321).
const anyCaseLetter = (letter: string) => {
  const cases = new Set(
    [letter, letter.toUpperCase(), letter.toLowerCase()].filter((form) =>
      /^.$/su.test(form),
    ),
  );
  return cases.size === 1 ? letter : `[${[...cases].join("")}]`;
};

// The names as one pattern, built a character at a time from each raw name,
// so only the name's own letters ever become any-case classes, never a
// letter in an escape or a class such as \s (#271). Any run of whitespace
// may part the words of a name, such as a no-break space, a line break or
// two spaces (#269).
export function namesPattern(
  names: readonly string[],
  anyCase: boolean,
): string {
  const char = (c: string) => {
    if (c === "-") return DASH;
    if (c === " ") return String.raw`\s+`;
    if (anyCase && /\p{L}/u.test(c)) return anyCaseLetter(c);
    return escape(c);
  };
  return names.map((name) => Array.from(name, char).join("")).join("|");
}

const NAMES = namesPattern(funder.names, false);
const ANY_CASE_NAMES = namesPattern(funder.names, true);
// Any letter, not only A to Z, makes a name part of a longer word (#320),
// and so does a combining mark, which belongs to the letter before it. A
// lookbehind, not a negated class, keeps the case-insensitive match from
// folding a letter onto a mark that is not one. Scripts that put no space
// between words, such as Chinese, Japanese and Thai, write a name straight
// against their own letters, so those letters do not join it (#337).
const NO_WORD_SPACE = String.raw`[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}\p{scx=Thai}\p{scx=Laoo}\p{scx=Khmr}\p{scx=Mymr}]`;
const EDGE = String.raw`(?:(?!${NO_WORD_SPACE})[\p{L}\p{M}])`;
const funderName = new RegExp(`(?<!${EDGE})(?:${NAMES})(?!${EDGE})`, "iu");

// The funder's name in either case, between the edges above, as a pattern
// for one whose own letters keep their case. Gold set B's draw builds its
// centre-or-institute check on it, so it reads a name where the rules do
// (#360).
export const ANY_CASE_FUNDER_NAME = `(?<!${EDGE})(?:${ANY_CASE_NAMES})(?!${EDGE})`;

// Whether text names the funder. Gold set B's draw reads names with this
// too, so its hard cases match what the rules read (#338).
export const namesFunder = (text: string): boolean => funderName.test(text);

// A reference's edges. Any letter or combining mark joined to a reference,
// not only A to Z, makes it part of a longer word, as at the funder's name
// (#339). So does a digit 0 to 9 or an underscore, as \b had it.
const WORD = String.raw`[\p{L}\p{M}\w]`;
const START = `(?<!${WORD})`;
const END = `(?!${WORD})`;

// A separator may be written as a slash, a backslash or the set minus sign.
const SEP = String.raw`\s?[/\\∖]\s?`;

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
    pattern: new RegExp(
      String.raw`${START}C\s?\d{1,6}${SEP}A\s?\d{4,6}${END}`,
      "gu",
    ),
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
    // month in title case written straight onto the code. Only a plain space
    // may follow the hyphen, as referenceSchema allows no other.
    pattern: new RegExp(
      String.raw`${START}[A-Z]{4,12}(?:${DASH} ?([A-Za-z0-9]{2,8})|((?:${MONTHS})(?:\d{4}|\d{2})))?${SEP}1\d{5}${END}`,
      "gu",
    ),
    sentenceOnly: false,
  },
  {
    // A G number counts only in the brackets straight after the funder's
    // name, as in "Cancer Research UK (G123/45)".
    format: "Gn/n",
    pattern: new RegExp(
      String.raw`(?<=(?<!${EDGE})(?:${ANY_CASE_NAMES})\s?\(\s?)G\d{2,4}${SEP}\d{1,4}${END}`,
      "gu",
    ),
    sentenceOnly: false,
  },
  {
    // A Francis Crick Institute core funding number, old style.
    format: "FCn",
    pattern: new RegExp(String.raw`${START}FC\s?\d{6}${END}`, "gu"),
    sentenceOnly: true,
  },
  {
    // A Francis Crick Institute core funding number, new style.
    format: "CCn",
    pattern: new RegExp(String.raw`${START}CC\s?\d{4}${END}`, "gu"),
    sentenceOnly: true,
  },
  {
    // A joint award named for the funder, such as Stand Up To Cancer's.
    format: "RTn",
    pattern: new RegExp(String.raw`${START}RT\s?\d{4}${END}`, "gu"),
    sentenceOnly: true,
  },
  {
    format: "An",
    pattern: new RegExp(String.raw`${START}A\s?\d{5}${END}`, "gu"),
    sentenceOnly: true,
  },
];

const UNICODE_DASH = new RegExp(`[${DASHES}]`, "gu");

// The reference as one form, for counting and matching. The model module
// calls it only after it has found the reference in the text as written.
export function normalise(written: string): string {
  return written
    .replace(/\s+/gu, "")
    .replace(/[\\∖]/gu, "/")
    .replace(UNICODE_DASH, "-")
    .toUpperCase();
}

// Splits a paragraph into sentences. Gold set B's draw reads sentences with
// this split too, so its checks scan what the rules scan (#360).
export function sentences(paragraph: string): string[] {
  // A full stop after a single capital, as in U.K., does not end one.
  return paragraph.split(/(?<=(?<!\b[A-Z])[.;!?])\s+(?=[A-Z(])/u);
}

// Finds the references in one piece of text. `long` keeps only the patterns
// that count anywhere, `short` only the sentence-only ones, and `all` both.
// A sentence-only match never counts inside a longer reference, such as the
// A part of a C/A reference.
function scan(text: string, keep: "long" | "short" | "all"): Reference[] {
  const found: Reference[] = [];
  const taken: [number, number][] = [];
  for (const { format, pattern, sentenceOnly } of PATTERNS) {
    if (sentenceOnly && keep === "long") continue;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (taken.some(([from, to]) => start < to && end > from)) continue;
      taken.push([start, end]);
      if (!sentenceOnly && keep === "short") continue;
      found.push({
        // A space inside a reference, such as a no-break space, is kept as
        // a plain one, the only space referenceSchema allows (#269).
        asWritten: match[0].replace(/\s/gu, " "),
        normalised: normalise(match[0]),
        format: typeof format === "string" ? format : format(match),
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
  const alone = new RegExp(`(?<!${WORD}|${SEP})${id}(?!${WORD}|${SEP})`, "u");
  return text.some((paragraph) => alone.test(paragraph));
}

// Whether another reference gives this number, after a letter such as its A
// or FC, or as the last part of a longer reference, so the number alone
// would list it twice. It is asked once every reference is found, so the
// order of the award groups does not matter (#241).
function alreadyFound(id: string, found: readonly Reference[]): boolean {
  const ending = new RegExp(`[A-Z/]${id}$`, "u");
  return found.some(({ normalised }) => ending.test(normalised));
}

export function findReferences(sections: FundingSections): Reference[] {
  const found: Reference[] = [];
  const bare: Reference[] = [];
  for (const paragraph of sections.text) {
    if (!funderName.test(paragraph)) continue;
    found.push(...scan(paragraph, "long"));
    for (const sentence of sentences(paragraph)) {
      if (!funderName.test(sentence)) continue;
      found.push(...scan(sentence, "short"));
    }
  }
  for (const award of sections.awards) {
    if (!award.sources.some((source) => funderName.test(source))) continue;
    // A bare number in an award shared with another funder may be that
    // funder's, so only a reference in a known format counts there (#128).
    const shared = award.sources.some((source) => !funderName.test(source));
    for (const id of award.ids) {
      const trimmed = id.trim();
      if (shared || !confirmedNumber(trimmed, sections.text)) {
        found.push(...scan(trimmed, "all"));
      } else {
        bare.push({ asWritten: trimmed, normalised: trimmed, format: "n" });
      }
    }
  }
  for (const reference of bare) {
    if (!alreadyFound(reference.normalised, found)) found.push(reference);
  }
  const seen = new Set<string>();
  return found.filter((reference) => {
    if (seen.has(reference.normalised)) return false;
    seen.add(reference.normalised);
    return true;
  });
}
