import { findReferences, type FundingSections } from "../src/extract/rules.ts";
import type { RowId } from "./floors.ts";

// Scores the extraction on the gold sets. It reads text already on disk and
// calls nothing outside src/extract/ and evals/, so the fingerprint covers
// everything that can change a score (docs/constraints/evals.md).

// Gold set A: papers Europe PMC already links to the funder's grants. Its
// links are the answers.
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

const canonical = (id: string): string =>
  id.replace(/\s+/gu, "").replace(/[\\∖]/gu, "/").toUpperCase();

// The ways one reference can be written: whole, each part of a C/A pair,
// and an award number with or without its A.
function forms(id: string): Set<string> {
  const whole = canonical(id);
  const parts = whole.split("/");
  const out = new Set([whole]);
  if (parts.length === 2 && /^C\d+$/u.test(parts[0] ?? "")) {
    out.add(parts[1] ?? "");
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

interface Input {
  texts: ReadonlyMap<string, FundingSections>;
  goldA: readonly GoldA[];
  goldB: readonly GoldB[];
}

const ratio = (part: number, whole: number): number | null =>
  whole === 0 ? null : part / whole;

export function score({ texts, goldA, goldB }: Input): Scores {
  const found = (pmcid: string): string[] => {
    const sections = texts.get(pmcid);
    if (sections === undefined) {
      throw new Error(
        `no text in the snapshot for ${pmcid}: a new gold paper needs a new snapshot id`,
      );
    }
    return findReferences(sections).map((reference) => reference.normalised);
  };

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
      // Only the rules run until the model lands (#24).
      "model-adds": { score: null, n: goldB.length },
      // The rules call no model, so they spend nothing.
      spend: { score: 0, n: goldA.length + goldB.length },
    },
    missedA,
  };
}
