import {
  ANY_CASE_FUNDER_NAME,
  DASHES,
  findReferences,
  hasReferenceShape,
  type FundingSections,
} from "../src/extract/rules.ts";
import type { RowId } from "./floors.ts";

// Scores the extraction on the gold sets. It reads text already on disk and
// calls nothing outside src/extract/ and evals/, so the fingerprint covers
// everything that can change a score (docs/constraints/evals.md).

// Gold set A: papers Europe PMC already links to the funder's grants. Its
// answers are the linked grants each paper prints (#502).
export interface GoldA {
  pmcid: string;
  grants: string[];
}

// Gold set B: unlinked papers. Two passes of a Claude model proposed the
// labels and the owner checked them (#175): 58 papers checked, and the other
// 42 accepted on a random sample of 10 with seed 20261109. The owner changed
// none. An empty list means the paper gives no reference.
export interface GoldB {
  pmcid: string;
  references: string[];
}

export interface Row {
  score: number | null;
  // How many gold papers the score is over.
  n: number;
}

export interface Scores {
  rows: Record<RowId, Row>;
  // Gold set A papers with a link the extraction did not find. Ids only.
  missedA: string[];
}

// A doubled backslash reads as one, and a trailing slash is dropped, as
// Europe PMC sometimes holds them (#503).
const canonical = (id: string): string =>
  id
    .replace(/\s+/gu, "")
    .replace(/\\\\/gu, "\\")
    .replace(/[\\∖]/gu, "/")
    .replace(/\/$/u, "")
    .toUpperCase();

// The ways one reference can be written: whole, each part of a C/A pair,
// and an award number with or without its A.
function forms(id: string): Set<string> {
  const out = new Set([canonical(id)]);
  // A reference whose own form starts with CRUK- or CRUK/ keeps it when
  // normalised, as the guide has it. Where the rest is a C/A pair or an
  // award number, the rest names the same grant (#506).
  for (const form of [...out]) {
    const rest = /^CRUK[-/](C\d+\/A?\d{4,6}|A?\d{4,6})$/u.exec(form)?.[1];
    if (rest !== undefined) out.add(rest);
  }
  for (const form of [...out]) {
    const parts = form.split("/");
    if (parts.length === 2 && /^C\d+$/u.test(parts[0] ?? "")) {
      out.add(parts[1] ?? "");
    }
  }
  for (const form of [...out]) {
    const award = /^A?(\d{4,6})$/u.exec(form);
    if (award?.[1] !== undefined) {
      out.add(award[1]);
      out.add(`A${award[1]}`);
    }
  }
  return out;
}

// Whether a reference the extraction found is the grant Europe PMC or a
// label names. Europe PMC often holds only the award part of a C/A pair,
// and sometimes the award number without its A. A C part alone names a
// programme, not a grant, so it never matches.
export function sameGrant(found: string, expected: string): boolean {
  const a = forms(found);
  return [...forms(expected)].some((form) => a.has(form));
}

// CRUK's reference forms (#503): a C/A pair; an award number of 4 to 6
// digits, with or without its A; a Crick core funding number; a newer
// reference of 4 to 12 capitals, sometimes with a hyphen and a year or with
// a month and a year of two or four digits, then a slash and six digits
// starting with 1, as the rules' CODE/n, CODE-YYYY/n and month shapes read
// it, so a shorter id such as AB/12 is not taken (#634); or one that starts
// with CRUK and is, whole, a shape the rules read, so it has a digit after
// the CRUK (#532). Only that last form takes an id that starts with CRUK,
// so the scorer never takes a CRUK id the rules refuse, such as CRUK/2019
// (#575). A C part alone names a programme, and another funder's
// reference, a word, a centre or partnership name such as CRUK_Manchester
// or CRUK/MRC, or the bare abbreviation CRUK is not a CRUK grant, so none
// of those is an answer.
const CRUK_FORMS = [
  /^C\d+\/A\d+$/u,
  /^A?\d{4,6}$/u,
  /^(?:FC|CC)\d+$/u,
  /^(?!CRUK)[A-Z]{4,12}(?:-(?:19|20)\d{2}|-?(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:\d{2}){1,2})?\/1\d{5}$/u,
];

export function crukReference(id: string): boolean {
  const whole = canonical(id);
  return (
    CRUK_FORMS.some((form) => form.test(whole)) ||
    (whole.startsWith("CRUK") && hasReferenceShape(whole))
  );
}

// The innermost reference list, which a loop removes until none is left, so
// a list nested in another goes too.
const REF_LIST = /<ref-list\b(?:(?!<ref-list\b)[\s\S])*?<\/ref-list\s*>/gu;

function withoutReferenceLists(article: string): string {
  let text = article;
  for (;;) {
    const next = text.replace(REF_LIST, " ");
    if (next === text) return text;
    text = next;
  }
}

// The front matter, an article's or a sub-article's, holds its metadata:
// its DOI, dates and copyright line. Only its funding groups and author
// notes are read, so a journal's own DOI or a year beside the funder's name
// in a copyright line is not taken for a grant (#555), while a funding
// footnote in the author notes, which the cutter keeps, still is. An empty
// element, written self-closing, holds nothing.
const FRONT = /<(front|front-stub)(?=[\s>])[^>]*>([\s\S]*?)<\/\1\s*>/gu;
const READ_IN_FRONT =
  /<(funding-group|author-notes)(?=[\s>/])(?:[^>]*\/>|[\s\S]*?<\/\1\s*>)/gu;

function withoutFrontMatter(article: string): string {
  return article.replace(
    FRONT,
    (_front, _tag, inner: string) =>
      ` ${(inner.match(READ_IN_FRONT) ?? []).join(" ")} `,
  );
}

// A form as a pattern that ignores case and spaces, with a slash written
// any way canonical reads one, and nothing alphanumeric either side of it.
// A space may not split a run of digits, or "1 2345" in a sentence, or two
// table cells, would read as 12345.
function standingAlone(form: string): RegExp {
  // A form holds only ASCII, as canonical leaves GRANT's characters.
  const chars = Array.from(form);
  const pattern = chars
    .map((char, i) => {
      const one = char === "/" ? "[/\\\\∖]" : char === "." ? "\\." : char;
      const before = chars[i - 1];
      const between =
        i > 0 && !(/\d/u.test(char) && /\d/u.test(before ?? "")) ? "\\s*" : "";
      return `${between}${one}`;
    })
    .join("");
  return new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, "iu");
}

// A bare number with a dot or a hyphen and then a digit on either side of
// it sits in a decimal, a range or a DOI, so it is not printed there
// (#520). A middle dot writes a decimal too, and a hyphen may be any dash
// the rules read as one (#556).
const JOINER = `[.\u00b7${DASHES}-]`;

// A DOI's prefix and the run of the characters a DOI holds after it, which
// ends at a space, a comma or an entity's ampersand. A bare number in this
// run is part of the DOI, whatever stands just before it, as in eLife's
// 10.7554/eLife.12345 (#597).
const IN_DOI = String.raw`\b10\.\d{4,9}/[-.;()/:\w]*`;

function bareNumber(digits: string): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9]|\\d${JOINER}|${IN_DOI})${digits}(?![A-Za-z0-9]|${JOINER}\\d)`,
    "giu",
  );
}

// A bare number that could be a year counts only within this many
// characters of a name the rules read for the funder (#520).
const NEAR_FUNDER = 50;
const YEAR = /^(?:19|20)\d{2}$/u;
const FUNDER_NAME = new RegExp(ANY_CASE_FUNDER_NAME, "gu");

interface Span {
  start: number;
  end: number;
}

function printedAs(form: string, text: string, names: Span[]): boolean {
  if (!/^\d+$/u.test(form)) return standingAlone(form).test(text);
  if (!YEAR.test(form)) return bareNumber(form).test(text);
  return [...text.matchAll(bareNumber(form))].some(({ index: start }) =>
    names.some(
      (name) =>
        start - name.end <= NEAR_FUNDER &&
        name.start - (start + form.length) <= NEAR_FUNDER,
    ),
  );
}

// The linked grants a paper prints, in the order given: those with a form
// sameGrant accepts standing alone in the whole article less its reference
// list and its front matter but for the funding groups and author notes
// there, ignoring case and spaces (#502, #503, #555). A grant cited only by
// another paper is not printed. Each markup tag reads as a space, and any
// run of spaces as one, so a tag inside a grant does not hide it and
// indentation does not part a year from the funder's name. A bare number
// joined to a digit by a dot, a middle dot or any dash the rules read as a
// hyphen, as in a decimal or a range, or anywhere in a DOI, or one that
// reads as a year far from the funder's name, is not printed (#520, #556,
// #597).
export function printedGrants(
  grants: readonly string[],
  article: string,
): string[] {
  const text = withoutReferenceLists(withoutFrontMatter(article))
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ");
  const names = [...text.matchAll(FUNDER_NAME)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
  return grants.filter((grant) =>
    [...forms(grant)].some(
      (form) => form !== "" && printedAs(form, text, names),
    ),
  );
}

// What a model added after the rules: the normalised references it found
// in each paper, what it spent over every gold paper, in US dollars, and
// the papers whose reply could not be read. Ids only.
export interface ModelPass {
  found: ReadonlyMap<string, readonly string[]>;
  spend: number;
  unprocessed: readonly string[];
}

interface Input {
  texts: ReadonlyMap<string, FundingSections>;
  goldA: readonly GoldA[];
  goldB: readonly GoldB[];
  // The rules alone when left out.
  model?: ModelPass;
  // False scores the model alone, without the rules' references (#694).
  rules?: boolean;
}

const ratio = (part: number, whole: number): number | null =>
  whole === 0 ? null : part / whole;

export function score({
  texts,
  goldA: sentA,
  goldB: sentB,
  model,
  rules = true,
}: Input): Scores {
  // A paper the model left unread is out of its scores alone, on every
  // gold set. After the rules it stays in, and scores what the rules found
  // in it (#696).
  const unread = new Set(rules ? [] : (model?.unprocessed ?? []));
  const goldA = sentA.filter((paper) => !unread.has(paper.pmcid));
  const goldB = sentB.filter((paper) => !unread.has(paper.pmcid));
  const found = (pmcid: string): string[] => {
    const sections = texts.get(pmcid);
    if (sections === undefined) {
      throw new Error(
        `no text in the snapshot for ${pmcid}: a new gold paper needs a new snapshot id`,
      );
    }
    // The rules first, then what the model adds, each reference once.
    return [
      ...new Set([
        ...(rules
          ? findReferences(sections).map((reference) => reference.normalised)
          : []),
        ...(model?.found.get(pmcid) ?? []),
      ]),
    ];
  };
  // Spend counts every call, read or not, over every gold paper sent.
  const papers = sentA.length + sentB.length;

  let grantsA = 0;
  let recalledA = 0;
  const missedA: string[] = [];
  for (const paper of goldA) {
    const refs = found(paper.pmcid);
    const hits = paper.grants.filter((grant) =>
      refs.some((ref) => sameGrant(ref, grant)),
    ).length;
    grantsA += paper.grants.length;
    recalledA += hits;
    if (hits < paper.grants.length) missedA.push(paper.pmcid);
  }

  let proposed = 0;
  let correct = 0;
  let truths = 0;
  let recalledB = 0;
  for (const paper of goldB) {
    const refs = found(paper.pmcid);
    proposed += refs.length;
    correct += refs.filter((ref) =>
      paper.references.some((truth) => sameGrant(ref, truth)),
    ).length;
    truths += paper.references.length;
    recalledB += paper.references.filter((truth) =>
      refs.some((ref) => sameGrant(ref, truth)),
    ).length;
  }

  return {
    rows: {
      "precision-b": {
        score: goldB.length === 0 ? null : (ratio(correct, proposed) ?? 1),
        n: goldB.length,
      },
      "recall-b": {
        score: goldB.length === 0 ? null : (ratio(recalledB, truths) ?? 1),
        n: goldB.length,
      },
      // Nothing goes to review until review lands (#26).
      "review-share": { score: null, n: 0 },
      "recall-a": { score: ratio(recalledA, grantsA), n: goldA.length },
      // Set by the runner, against the rules alone. A model alone adds
      // nothing after the rules, so it stays empty there.
      "model-adds": { score: null, n: goldB.length },
      // The rules call no model, so they spend nothing. A model's spend is
      // per 1,000 papers, and unmeasured when it read none.
      spend: {
        score:
          model === undefined
            ? 0
            : papers === 0
              ? null
              : (model.spend / papers) * 1000,
        n: papers,
      },
    },
    missedA,
  };
}
