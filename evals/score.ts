import { findReferences, type FundingSections } from "../src/extract/rules.ts";
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
// reference of letters, sometimes with a year or a month, then a slash and
// a number; or one that starts with CRUK. A C part alone names a
// programme, and another funder's reference or a word is not CRUK's, so
// none of those is an answer.
const CRUK_FORMS = [
  /^C\d+\/A\d+$/u,
  /^A?\d{4,6}$/u,
  /^(?:FC|CC)\d+$/u,
  /^[A-Z]+(?:-?(?:(?:19|20)\d{2}|(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}))?\/\d+$/u,
  /^CRUK/u,
];

export function crukReference(id: string): boolean {
  const whole = canonical(id);
  return CRUK_FORMS.some((form) => form.test(whole));
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

// The linked grants a paper prints, in the order given: those with a form
// sameGrant accepts standing alone in the whole article less its reference
// list, ignoring case and spaces (#502, #503). A grant cited only by
// another paper is not printed. Each markup tag reads as a space, so a tag
// inside a grant does not hide it.
export function printedGrants(
  grants: readonly string[],
  article: string,
): string[] {
  const text = withoutReferenceLists(article).replace(/<[^>]*>/gu, " ");
  return grants.filter((grant) =>
    [...forms(grant)].some(
      (form) => form !== "" && standingAlone(form).test(text),
    ),
  );
}

// What a model added after the rules: the normalised references it found
// in each paper, and what it spent over every gold paper, in US dollars.
export interface ModelPass {
  found: ReadonlyMap<string, readonly string[]>;
  spend: number;
}

interface Input {
  texts: ReadonlyMap<string, FundingSections>;
  goldA: readonly GoldA[];
  goldB: readonly GoldB[];
  // The rules alone when left out.
  model?: ModelPass;
}

const ratio = (part: number, whole: number): number | null =>
  whole === 0 ? null : part / whole;

export function score({ texts, goldA, goldB, model }: Input): Scores {
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
        ...findReferences(sections).map((reference) => reference.normalised),
        ...(model?.found.get(pmcid) ?? []),
      ]),
    ];
  };
  const papers = goldA.length + goldB.length;

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
      // Set by the runner, against the rules alone.
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
