import { z } from "zod";
import funderFile from "./funder.json" with { type: "json" };
import { latest, type Version } from "./versions.ts";

// The rules pass: reads grant references out of a paper's funding sections
// with patterns, before any model sees the paper. It returns references
// only, never the text around them, so nothing it returns can carry a name
// (docs/constraints/personal-data.md).

// Bump this whenever a pattern, or which references the rules keep,
// changes, so every stored result says which rules made it. To bump, add a
// line naming your issue at the end of RULES_VERSIONS below (see
// versions.ts, #414).
export const RULES_VERSIONS: readonly Version[] = [
  { number: 10, issue: 368 },
  { number: 11, issue: 506 },
  { number: 12, issue: 510 },
];
export const RULES_VERSION = latest("rules", RULES_VERSIONS);

export const funder = z
  .object({
    name: z.string().min(1),
    // The names the search, the prompt and the rules all read.
    names: z.array(z.string().min(1)).min(1),
    // Names only the rules read: too common as words to widen the search
    // with, but plain enough in a paragraph that names a grant (#510).
    rulesOnlyNames: z.array(z.string().min(1)),
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
    // Only the characters a reference is made of. These include letters and
    // spaces, so this alone does not keep out a name: the rules' patterns
    // match no name, and the model pass refuses a reply that carries a word
    // set apart by spaces (#413), or a lower-case letter outside a month in
    // a code (#467).
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
// The model pass reads a code's hyphen with this too (#413).
export const DASH = `[-${DASHES}]`;
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

const RULES_NAMES = [...funder.names, ...funder.rulesOnlyNames];
const NAMES = namesPattern(RULES_NAMES, false);
const ANY_CASE_NAMES = namesPattern(RULES_NAMES, true);
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
// (#339). So does any decimal digit, not only 0 to 9 (#368), and an
// underscore, as \b had it.
const WORD = String.raw`[\p{L}\p{M}\p{Nd}_]`;
const START = `(?<!${WORD})`;
const END = `(?!${WORD})`;

// A reference as written, between the edges above. The model pass checks
// its references with this, so the two passes cannot draw a reference's
// edges differently (#384).
export const wholeReference = (reference: string): RegExp =>
  new RegExp(`${START}${escape(reference)}${END}`, "u");

// A separator may be written as a slash, a backslash or the set minus sign.
const SEP = String.raw`\s?[/\\∖]\s?`;

interface Pattern {
  format: string | ((match: RegExpMatchArray) => string);
  pattern: RegExp;
  // A short number such as an A number is common, so it counts only in a
  // sentence that names the funder.
  sentenceOnly: boolean;
}

// The words that tie a bare number to the funder's name before it, such as
// "grant", "award no." or "reference number", ending in the space or mark
// before the number (#506). Not part of a longer word.
const TIE_WORD = String.raw`(?<!\p{L})(?:[Gg]rant|[Aa]ward|[Pp]roject|[Rr]ef(?:erence)?|[Nn]umber|[Nn]o)s?\.?(?:\s?(?:[Nn]o|[Nn]umber|[Rr]ef)\.?)?\s?[:#]?\s?`;

// The model pass reads a month in a code with this too (#467).
export const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

const PATTERNS: Pattern[] = [
  {
    // Either letter may be written in lower case (#506).
    format: "Cn/An",
    pattern: new RegExp(
      String.raw`${START}[Cc]\s?\d{1,6}${SEP}[Aa]\s?\d{4,6}${END}`,
      "gu",
    ),
    sentenceOnly: false,
  },
  {
    // A reference that carries the funder's short name as its own part, as
    // in CRUK/12/034, CRUKDF-0123-AB or ABC-CRUK-ABCD12-AB (#506). The
    // guide keeps the CRUK in its normalised form. It must hold a digit
    // after the CRUK, within what it matches, so a word such as CRUK-funded
    // or a run of names such as CRUK/MRC/EPSRC is not one. It comes after
    // the C/A pattern, so a C/A pair after CRUK/ is read as the pair alone.
    format: "CRUK-X",
    pattern: new RegExp(
      String.raw`${START}(?:[A-Z]{2,6}${DASH})?CRUK[A-Z]{0,6}(?:(?:${DASH}|/)[A-Z0-9]{1,8}){1,4}(?<=CRUK[A-Z0-9/${DASHES}-]*\d[A-Z0-9/${DASHES}-]*)${END}`,
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
    // A Francis Crick Institute core funding number, old style. One printed
    // with a digit or two too many is kept as printed (#175 rule 6, #506).
    format: "FCn",
    pattern: new RegExp(String.raw`${START}FC\s?\d{6,8}${END}`, "gu"),
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
    // Four digits only when written straight onto the A (#506). A
    // four-digit A before another A number, as in A1234/A56789, is the C
    // part of a misprinted C/A pair, which is left to the model (#177).
    format: "An",
    pattern: new RegExp(
      String.raw`${START}A(?:\s?\d{5}${END}|\d{4}${END}(?!${SEP}A\s?\d))`,
      "gu",
    ),
    sentenceOnly: true,
  },
  {
    // A bare award number, which the text ties to the funder: in brackets
    // straight after its name, or after a word such as "grant" or "award
    // no." that follows its name in the same clause, with no comma,
    // semicolon or full stop between (#506). A year is not one, and nor is
    // the start of a longer number, as in 12345/2, 12345-67 or 1234.5.
    format: "n",
    pattern: new RegExp(
      String.raw`(?<=(?<!${EDGE})(?:${ANY_CASE_NAMES})(?!${EDGE})(?:\s?\(\s?|[^;,.]{0,100}?${TIE_WORD}))(?!(?:19|20)\d{2}(?!\d))\d{4,6}${END}(?!${SEP}|${DASH}\d|\.\d)`,
      "gu",
    ),
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
  // A full stop after a single capital, as in U.K., does not end one, nor
  // does the one in "no." before a reference, as in "(no. FC001234)" (#506).
  return paragraph.split(
    /(?<=(?<!\b[A-Z])[.;!?])(?<!\b[Nn]os?\.)\s+(?=[A-Z(])/u,
  );
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
// joined to a letter, any decimal digit or a separator is part of a longer
// reference.
const BARE_NUMBER = /^\d{5,7}$/u;

function confirmedNumber(id: string, text: readonly string[]): boolean {
  if (!BARE_NUMBER.test(id)) return false;
  const alone = new RegExp(`(?<!${WORD}|${SEP})${id}(?!${WORD}|${SEP})`, "u");
  return text.some((paragraph) => alone.test(paragraph));
}

// Whether another reference gives this number, after a letter such as its A
// or FC, or as the last part of a longer reference after a slash or a
// hyphen, as in CRUK-12345, so the number alone would list it twice. It is
// asked once every reference is found, so the order of the award groups
// does not matter (#241).
function alreadyFound(id: string, found: readonly Reference[]): boolean {
  const ending = new RegExp(`[A-Z/-]${id}$`, "u");
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
      // A bare number the text gives waits, as one from the metadata does,
      // so an A number or a longer reference that ends in it lists it once.
      for (const reference of scan(sentence, "short")) {
        (reference.format === "n" ? bare : found).push(reference);
      }
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
