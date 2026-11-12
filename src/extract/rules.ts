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
  { number: 13, issue: 525 },
  { number: 14, issue: 514 },
  { number: 15, issue: 573 },
  { number: 16, issue: 560 },
  { number: 17, issue: 598 },
  { number: 18, issue: 642 },
  { number: 19, issue: 577 },
  { number: 20, issue: 579 },
];
export const RULES_VERSION = latest("rules", RULES_VERSIONS);

export const funder = z
  .object({
    name: z.string().min(1),
    // The names the search, the prompt and the rules all read.
    names: z.array(z.string().min(1)).min(1),
    // Names the search and the prompt leave out: too common as words to
    // widen the search with, but plain enough in a paragraph that names a
    // grant (#510). Whatever reads namesFunder reads them too, such as the
    // JATS check for a funding footnote and gold set B's draw.
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
export const DASHES = `${String.fromCodePoint(0x2010)}-${String.fromCodePoint(0x2015)}${String.fromCodePoint(0x2212)}`;

export const referenceSchema = z
  .object({
    // Only the characters a reference is made of. These include letters and
    // spaces, so this alone does not keep out a name: the rules' patterns
    // match no name, and the model pass refuses a reply that is not one of
    // their shapes in capitals, but for a month in a code, or a bare number
    // (#467, #492).
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

// A separator may be written as a slash, a backslash or the set minus sign.
const SEP = String.raw`\s?[/\\∖]\s?`;

// What may not follow a bare number, so it is not the start of a longer
// one, as in 12345/2, 12345-67 or 1234.5.
const NUMBER_AFTER = String.raw`(?!${SEP}|${DASH}\d|\.\d)`;

// An A number inside another funder's reference, with letters and a slash
// before it and a slash and more after it, as in CAN/A00004/1, is part of
// that reference, not the funder's (#642). A slash here is written straight
// against both its neighbours, so a list spaced with slashes is not one,
// and another A number after it makes a list too, as in grant/A12345/A23456.
// Read at the A, before the shape.
const TIGHT_SEP = String.raw`[/\\∖]`;
const NOT_INSIDE_REFERENCE = String.raw`(?:(?<!\p{L}${TIGHT_SEP})|(?!A\s?\d+${TIGHT_SEP}(?!A\s?\d)${WORD}))`;

// An A number, as the An shape reads it.
const A_SHAPE = String.raw`A(?:\s?\d{5}|\d{4}${END}(?!${SEP}A\s?\d))`;

interface Shape {
  format: string | ((match: RegExpMatchArray) => string);
  // The reference alone, built from the pieces below. The rules read it
  // between a reference's edges, after `before` where one is given, and the
  // model pass reads a reply only if it is one of these shapes whole (#492).
  shape: string;
  // The shape the model pass reads instead, where it is narrower.
  modelShape?: string;
  // What must come before and after it in the text, beyond its edges.
  before?: string;
  after?: string;
  // Whether the model pass keeps a reply of this shape only where the
  // rules' own scan reads that reply, and no more or less, in the text.
  // A form with a prefix and up to four parts may run on past a reply, as
  // CRUK/12/34 does past CRUK/12 (#561), and an earlier pattern may take
  // part of it, as the C/A pattern does in CRUK/C1234/A56789 (#599).
  readWhole?: true;
  // A short number such as an A number is common, so it counts only in a
  // sentence that names the funder.
  sentenceOnly: boolean;
}

// The words that tie a bare number to the funder's name before it, such as
// "grant", "award no." or "reference number", ending in the space or mark
// before the number (#506). Not part of a longer word.
const TIE_WORD = String.raw`(?<!\p{L})(?:[Gg]rant|[Aa]ward|[Pp]roject|[Rr]ef(?:erence)?|[Nn]umber|[Nn]o)s?\.?(?:\s?(?:[Nn]o|[Nn]umber|[Rr]ef)\.?)?\s?[:#]?\s?`;

// Where another funder is named: "and", "with", "as well as" or "&", with
// "by" or "from" after it if the text gives one, then a name in capitals,
// with "the" before it if the text gives one (#525). A number after that
// name is the other funder's. A word such as "Grant" or "Award No." before
// the number is not a name, as in "with Grant 12345". Between two words in
// capitals other than the funder's own name, with no "the", the "and" is
// part of one name, as in a committee the funder names, such as "Example
// and Sample Committee" (#506). Any run of whitespace may part the words,
// as in a name (#269).
const JOINER = String.raw`(?:(?:and|with|as\s+well\s+as)\s+(?:(?:by|from)\s+)?|&\s*)`;
const NAMED = String.raw`(?!(?:${TIE_WORD})+\d)\p{Lu}`;
const JOINED_NAME = String.raw`${JOINER}(?:[Tt]he\s+)?${NAMED}`;
const ANOTHER_FUNDER = String.raw`\s+(?:(?<!\p{Lu}\p{L}*\s+)${JOINER}|${JOINER}[Tt]he\s+)${NAMED}`;

// A month as the rules read it in a code.
const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

// Each pattern's pieces, stated once. A prefix of capitals may stand apart
// from its number by one space. A code's suffix follows a hyphen, which a
// space may follow, or else is a month in title case written straight onto
// the code. Only a plain space may follow the hyphen, as referenceSchema
// allows no other.
const prefixed = (prefix: string, digits: string) =>
  String.raw`${prefix}\s?\d{${digits}}`;
const YEAR = String.raw`(?:\d{4}|\d{2})`;
const MONTH_YEAR = `(?:${MONTHS})${YEAR}`;
const coded = (suffix: string) =>
  String.raw`[A-Z]{4,12}(?:${DASH} ?(${suffix})|(${MONTH_YEAR}))?${SEP}1\d{5}`;
// The rules read a suffix in any case. A name has lower-case letters, so
// the model pass reads one only in capitals and digits, or as a month in
// title case and its year, as in "ABCDEF-Mar21/100010" (#467).
const SUFFIX = "[A-Za-z0-9]{2,8}";
const CAPITAL_SUFFIX = `[A-Z0-9]{2,8}|${MONTH_YEAR}`;

// A year as the rules read it in a bare number or a CRUK- form.
const A_YEAR = String.raw`(?:19|20)\d{2}`;

// A CRUK- form's parts. Each follows a hyphen or a slash and is a whole run
// of up to eight capitals and digits, never a year alone. Every part but
// the last holds a digit (#514). The last may instead be one or two
// capitals, as in CRUKDF-0123-AB, so a name in capitals cannot end the
// form (#560).
const CRUK_SEP = `(?:${DASH}|/)`;
const CRUK_DIGIT_PART = String.raw`${CRUK_SEP}(?=[A-Z]*\d)(?!${A_YEAR}(?![A-Z0-9]))[A-Z0-9]{1,8}(?![A-Z0-9])`;
const CRUK_LETTER_PART = String.raw`${CRUK_SEP}[A-Z]{1,2}(?![A-Z0-9])`;
const CRUK_PART = `(?:${CRUK_DIGIT_PART}|${CRUK_LETTER_PART})`;
// No part of any kind follows, so a read is the whole form, not its front.
// Here a part is anything that starts with a capital or a digit, however
// long, so a name of nine or more capitals, too long to be a part the form
// reads, still does not leave the front to be read (#579). Besides a
// hyphen or a slash, a part may follow a backslash, the set minus sign, or
// a slash with a space on one side of it (#598). A slash with a
// space on each side parts a list of references, as in
// "CRUK-A12345 / CRUK-A23456", so it ends the form.
const NEXT_PART_SEP = String.raw`(?:${DASH}|[/\\∖]\s?|\s[/\\∖](?!\s))`;
const NO_MORE_PARTS = String.raw`(?!${NEXT_PART_SEP}[A-Z0-9])`;
// One to four parts, read whole. A form that runs on past four parts reads
// its first four, as the model pass keeps them (#561), unless the fourth
// has no digit and another part follows it.
const CRUK_PARTS = [
  `${CRUK_DIGIT_PART}${NO_MORE_PARTS}`,
  `(?:${CRUK_DIGIT_PART}){1,2}${CRUK_PART}${NO_MORE_PARTS}`,
  `(?:${CRUK_DIGIT_PART}){3}(?:${CRUK_DIGIT_PART}|${CRUK_LETTER_PART}${NO_MORE_PARTS})`,
].join("|");

const SHAPES: readonly Shape[] = [
  {
    // Either letter may be written in lower case (#506).
    format: "Cn/An",
    shape: `${prefixed("[Cc]", "1,6")}${SEP}${prefixed("[Aa]", "4,6")}`,
    // The model pass reads both letters in capitals only (#467).
    modelShape: `${prefixed("C", "1,6")}${SEP}${prefixed("A", "4,6")}`,
    sentenceOnly: false,
  },
  {
    // A reference that carries the funder's short name as its own part, as
    // in CRUK/12/034, CRUKDF-0123-AB or ABC-CRUK-ABCD12-AB (#506). The
    // guide keeps the CRUK in its normalised form. It must hold a digit
    // after the CRUK, within what it matches, so a word such as CRUK-funded
    // or a run of names such as CRUK/MRC/EPSRC is not one. It comes after
    // the C/A pattern, so a C/A pair after CRUK/ is read as the pair alone.
    // Every part after the CRUK but the last holds a digit, and no part is
    // a year alone, so a name in capitals, as in CRUK/SMITH/2, or a year,
    // as in CRUK/2019, is not one. The form is read whole or not at all, so
    // CRUK/12 is not read from CRUK/12/2019, nor CRUK/AB12 from
    // CRUK/AB12/SMITH/2 (#514). A last part with no digit holds at most
    // two capitals, so CRUK/12/JONES is not one either (#560). Nor is
    // CRUK/12 read from CRUK/12\2019 or CRUK/12 /2019, where the next part
    // follows a backslash or a slash spaced on one side (#598), nor from
    // CRUK/12/MCALLISTER, where the next part is too long to read (#579).
    format: "CRUK-X",
    shape: String.raw`(?:[A-Z]{2,6}${DASH})?CRUK[A-Z]{0,6}(?:${CRUK_PARTS})`,
    readWhole: true,
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
    shape: coded(SUFFIX),
    modelShape: coded(CAPITAL_SUFFIX),
    sentenceOnly: false,
  },
  {
    // A G number counts only in the brackets straight after the funder's
    // name, as in "Cancer Research UK (G123/45)".
    format: "Gn/n",
    shape: String.raw`G\d{2,4}${SEP}\d{1,4}`,
    before: String.raw`(?<=(?<!${EDGE})(?:${ANY_CASE_NAMES})\s?\(\s?)`,
    sentenceOnly: false,
  },
  {
    // A Francis Crick Institute core funding number, old style. One printed
    // with a digit or two too many is kept as printed (#175 rule 6, #506).
    format: "FCn",
    shape: prefixed("FC", "6,8"),
    sentenceOnly: true,
  },
  {
    // A Francis Crick Institute core funding number, new style.
    format: "CCn",
    shape: prefixed("CC", "4"),
    sentenceOnly: true,
  },
  {
    // A joint award named for the funder, such as Stand Up To Cancer's.
    format: "RTn",
    shape: prefixed("RT", "4"),
    sentenceOnly: true,
  },
  {
    // Four digits only when written straight onto the A (#506). A
    // four-digit A before another A number, as in A1234/A56789, is the C
    // part of a misprinted C/A pair, which is left to the model (#177).
    format: "An",
    shape: A_SHAPE,
    before: `${START}${NOT_INSIDE_REFERENCE}`,
    sentenceOnly: true,
  },
  {
    // A bare award number, which the text ties to the funder: in brackets
    // straight after its name, or after a word such as "grant" or "award
    // no." that follows its name in the same clause, with no comma,
    // semicolon or full stop between (#506), and no other funder named
    // (#525). A year is not one, and nor is the start of a longer number,
    // as in 12345/2, 12345-67 or 1234.5.
    format: "n",
    shape: String.raw`(?!${A_YEAR}(?!\d))\d{4,6}`,
    before: String.raw`(?<=(?<!${EDGE})(?:${ANY_CASE_NAMES})(?!${EDGE})(?:\s?\(\s?|(?!\s*${JOINED_NAME})(?:(?!${ANOTHER_FUNDER})[^;,.]){0,100}?${TIE_WORD}))`,
    after: NUMBER_AFTER,
    sentenceOnly: true,
  },
];

const PATTERNS = SHAPES.map(
  ({ format, shape, before, after, sentenceOnly }) => ({
    format,
    pattern: new RegExp(`${before ?? START}${shape}${END}${after ?? ""}`, "gu"),
    sentenceOnly,
  }),
);

// A bare number, as an award id the metadata gives, or as the model may read
// one tied to the funder only by name, with a suffix of two digits after a
// hyphen, as in "123456-01" (#97, #177).
const BARE = String.raw`\d{5,7}`;
const BARE_SUFFIX = String.raw`${DASH}\d{2}`;
// Any bare number a reply may be, of the n shape's four digits or of BARE's
// five to seven, with or without its suffix.
const BARE_REPLY = new RegExp(String.raw`^\d+(?:${BARE_SUFFIX})?$`, "u");
// What may not come before a bare number, so it is not the end of a longer
// one, as in 12/345678, ABC-123456 or 1.23456. The rules' n shape reads a
// bare number from the text only after a bracket, a tie word, a colon or a
// hash, so it never reads one there (#571). A number the metadata gives
// counts only with this edge too (#573).
const NUMBER_BEFORE = String.raw`(?<!${SEP}|${DASH}|\d\.)`;

// A reference as written, between the edges above. A bare number of any
// length counts only where the text neither runs into it nor goes on past
// it, as the rules read one (#567, #571).
const A_REPLY = new RegExp(`^${A_SHAPE}$`, "u");
const wholeReference = (reference: string): RegExp => {
  const bare = BARE_REPLY.test(reference);
  const aNumber = A_REPLY.test(reference);
  return new RegExp(
    `${bare ? NUMBER_BEFORE : ""}${START}${aNumber ? NOT_INSIDE_REFERENCE : ""}${escape(reference)}${END}${bare ? NUMBER_AFTER : ""}`,
    "u",
  );
};

// Whether a reference, as written with plain spaces, is a shape the rules
// read, in capitals but for a month in a code, or a bare number with an
// optional suffix, and nothing more. The model
// pass keeps only a reply of these shapes, so a name next to a number is
// never one (#492).
const READ_SHAPE = new RegExp(
  `^(?:${[...SHAPES.map(({ shape, modelShape }) => modelShape ?? shape), `${BARE}(?:${BARE_SUFFIX})?`].join("|")})$`,
  "u",
);
export const hasReferenceShape = (reference: string): boolean =>
  READ_SHAPE.test(reference);

const READ_WHOLE = new RegExp(
  `^(?:${SHAPES.filter(({ readWhole }) => readWhole === true)
    .map(({ shape, modelShape }) => modelShape ?? shape)
    .join("|")})$`,
  "u",
);

// Whether a paragraph gives a reference as written whole, between the edges
// above. The model pass checks its references with this, so the two passes
// cannot draw a reference's edges differently (#384). A reference of a shape
// the rules read whole, such as a CRUK- form, counts only where the rules'
// own scan reads just that reference (#561). The scan runs every pattern in
// turn, so where an earlier one takes the text, as the C/A pattern takes
// C1234/A56789 out of CRUK/C1234/A56789, the CRUK- form is not read (#599).
// Any other counts between the edges above, as wholeReference reads it.
export function readsWhole(paragraph: string, reference: string): boolean {
  if (READ_WHOLE.test(reference)) {
    return scan(paragraph, "long").some(
      ({ asWritten }) => asWritten === reference,
    );
  }
  return wholeReference(reference).test(paragraph);
}

// Any dash the rules read as a hyphen. The eval's scorer reads the text
// with it too (#581).
export const UNICODE_DASH = new RegExp(`[${DASHES}]`, "gu");

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
// acknowledgement text gives the same number, standing alone (#97). It needs
// the edges a model reply needs, as wholeReference draws them, so the two
// passes agree: a number joined to a letter, any decimal digit or a
// separator, after a hyphen or a digit and a decimal point (#573), or before
// a hyphen and a digit or a decimal point and a digit (#577), is part of a
// longer reference.
const BARE_NUMBER = new RegExp(`^${BARE}$`, "u");

function confirmedNumber(id: string, text: readonly string[]): boolean {
  if (!BARE_NUMBER.test(id)) return false;
  const alone = wholeReference(id);
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
