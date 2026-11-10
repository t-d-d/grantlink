import {
  EuropePmcError,
  LARGEST_PAGE_SIZE,
  type EuropePmc,
} from "../../src/europepmc/client.ts";
import { fundingSections } from "../../src/europepmc/jats.ts";
import {
  ANY_CASE_FUNDER_NAME,
  findReferences,
  namesFunder,
  sentences,
} from "../../src/extract/rules.ts";
import { sample } from "../../src/pipeline/snapshot.ts";

// Draws gold set B's 100 papers (#3): a seeded draw from the unlinked set,
// spread across the years in proportion, that first takes a few papers for
// each hard case the PRD names. The hard-case checks read a paper's text in
// memory and return only the names of the cases, so nothing here can print
// funding text or names (docs/constraints/personal-data.md).

export const HARD_CASES = [
  "declared-interest",
  "centre-or-institute",
  "affiliation-only",
  "several-funders",
  "no-reference",
] as const;

export type HardCase = (typeof HARD_CASES)[number];

// The funder's name as the rules read it, with any dash, any run of
// whitespace and the rules' own edge (#360). The words after it keep their
// case, so the name carries its case in its own pattern.
const centre = new RegExp(
  `${ANY_CASE_FUNDER_NAME}(?:\\s+[A-Z][A-Za-z'&-]*){0,4}\\s+(?:Centre|Center|Institute|Unit)\\b`,
  "u",
);
// Words that say a mention is about money or support, not about a place.
const FUNDING_WORDS =
  /fund|grant|support|award|fellow|financ|sponsor|studentship|programme|program\b/iu;
// Other funders a CRUK paper often names beside it.
const OTHER_FUNDERS =
  /\b(?:Wellcome|Medical Research Council|MRC|NIHR|National Institute for Health (?:and Care )?Research|National Institutes of Health|NIH|NCI|European Research Council|ERC|Horizon 2020|BBSRC|EPSRC|UKRI|Breast Cancer Now|Prostate Cancer UK|Blood Cancer UK|Worldwide Cancer Research|Rosetrees|Bloodwise|Leukaemia|CRIS Cancer Foundation|Deutsche Forschungsgemeinschaft|Swiss National Science Foundation|Dutch Cancer Society|KWF|Novo Nordisk Foundation|Danish Cancer Society|Cancer Council|NHMRC|Canadian Institutes of Health Research|Chief Scientist Office|Kidney Research UK|British Heart Foundation)\b/u;

const COI_FN =
  /<fn\b[^>]*fn-type="(?:COI-statement|conflict|competing-interests?)"[^>]*>([\s\S]*?)<\/fn>/giu;
const COI_SEC =
  /<(sec|notes)\b[^>]*>\s*(?:<label\b[^>]*>[\s\S]*?<\/label>\s*)?<title\b[^>]*>\s*(?:competing interests?|conflicts? of interests?|declaration of (?:competing )?interests?|disclosures?|conflict of interest statement)[\s\S]*?<\/\1>/giu;

const plain = (xml: string) =>
  xml
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

// Which hard cases a paper's full text shows, by these checks. They are a
// guide for drawing the sample; the owner's labels decide.
export function hardCases(xml: string): HardCase[] {
  const sections = fundingSections(xml);
  const text = sections.text.join(" ");
  const mentions = sections.text
    .flatMap(sentences)
    .filter((s) => namesFunder(s));
  const asFunder = mentions.filter((s) => FUNDING_WORDS.test(s));
  const interests = [
    ...[...xml.matchAll(COI_FN)].map((match) => match[1] ?? ""),
    ...[...xml.matchAll(COI_SEC)].map((match) => match[0]),
  ].map(plain);
  const others =
    OTHER_FUNDERS.test(text) ||
    sections.awards.some((award) =>
      award.sources.some((source) => source !== "" && !namesFunder(source)),
    );

  const found: HardCase[] = [];
  if (interests.some((note) => namesFunder(note))) {
    found.push("declared-interest");
  }
  if (centre.test(text)) found.push("centre-or-institute");
  if (mentions.length > 0 && asFunder.length === 0) {
    found.push("affiliation-only");
  }
  if (asFunder.length > 0 && others) found.push("several-funders");
  if (asFunder.length > 0 && findReferences(sections).length === 0) {
    found.push("no-reference");
  }
  return found;
}

// Shares `size` among the groups in proportion to their counts, by largest
// remainder. Ties go to the group that sorts first.
export function allocate(
  counts: Record<string, number>,
  size: number,
): Record<string, number> {
  const groups = Object.keys(counts).sort();
  const total = groups.reduce((sum, group) => sum + (counts[group] ?? 0), 0);
  if (total === 0) return Object.fromEntries(groups.map((g) => [g, 0]));
  const exact = groups.map((group) => ({
    group,
    share: ((counts[group] ?? 0) * size) / total,
  }));
  const shares: Record<string, number> = Object.fromEntries(
    exact.map(({ group, share }) => [group, Math.floor(share)]),
  );
  let left = size - Object.values(shares).reduce((a, b) => a + b, 0);
  const byRemainder = [...exact].sort(
    (a, b) =>
      b.share - Math.floor(b.share) - (a.share - Math.floor(a.share)) ||
      a.group.localeCompare(b.group),
  );
  for (const { group } of byRemainder) {
    if (left === 0) break;
    shares[group] = (shares[group] ?? 0) + 1;
    left -= 1;
  }
  return shares;
}

export interface Plan {
  // The unlinked set, as a Europe PMC query. The client adds the
  // open-access terms itself.
  base: string;
  seed: number;
  size: number;
  perHardCase: number;
  // Each hard case's query, which must find only papers the base finds.
  hardCases: { name: HardCase; query: string }[];
}

export interface Drawn {
  pmcid: string;
  year: string;
  pickedFor: HardCase | "year";
}

// How far down a hard case's order the draw reads before it gives up.
const MAX_READS = 60;

async function everything(
  api: EuropePmc,
  query: string,
): Promise<{ pmcid: string; year: string }[]> {
  const found = new Map<string, string>();
  let cursor: string | null = "*";
  while (cursor !== null) {
    const page = await api.search(cursor, query, LARGEST_PAGE_SIZE);
    for (const paper of page.papers) {
      found.set(paper.pmcid, paper.firstPublished?.slice(0, 4) ?? "unknown");
    }
    cursor = page.nextCursor;
  }
  return [...found].map(([pmcid, year]) => ({ pmcid, year }));
}

// A 4xx other than 429 means Europe PMC has no full text for the paper
// (docs/constraints/europe-pmc.md). Any other failure stops the draw, so a
// passing outage cannot change which papers it picks.
const noFullText = (error: unknown) =>
  error instanceof EuropePmcError &&
  error.status !== undefined &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 429;

export async function draw(
  api: EuropePmc,
  plan: Plan,
): Promise<{ papers: Drawn[]; sheetOrder: string[]; population: number }> {
  // Each distinct query is searched once: Europe PMC's pace makes a
  // search of the whole unlinked set cost a minute or more.
  const searches = new Map<
    string,
    Promise<{ pmcid: string; year: string }[]>
  >();
  const search = (query: string) => {
    const known = searches.get(query);
    if (known !== undefined) return known;
    const found = everything(api, query);
    searches.set(query, found);
    return found;
  };
  // Each paper is read once, though two hard cases may share a query
  // (europe-pmc.md: a paper already read is not fetched again). null means
  // Europe PMC has no full text for it.
  const read = new Map<string, Promise<HardCase[] | null>>();
  const casesOf = (pmcid: string) => {
    const known = read.get(pmcid);
    if (known !== undefined) return known;
    const found = api.fullText(pmcid).then(hardCases, (error: unknown) => {
      if (noFullText(error)) return null;
      throw error;
    });
    read.set(pmcid, found);
    return found;
  };
  const base = await search(plan.base);
  const years = new Map(base.map(({ pmcid, year }) => [pmcid, year]));
  const papers: Drawn[] = [];
  const taken = new Set<string>();

  for (const { name, query } of plan.hardCases) {
    const hits = await search(query);
    const stray = hits.find(({ pmcid }) => !years.has(pmcid));
    if (stray !== undefined) {
      throw new Error(`${name}: ${stray.pmcid} is not in the unlinked set`);
    }
    const order = sample(
      hits.map(({ pmcid }) => pmcid),
      plan.seed,
    ).filter((pmcid) => !taken.has(pmcid));
    let picked = 0;
    for (const pmcid of order.slice(0, MAX_READS)) {
      if (picked === plan.perHardCase) break;
      const cases = await casesOf(pmcid);
      if (!cases?.includes(name)) continue;
      papers.push({
        pmcid,
        year: years.get(pmcid) ?? "unknown",
        pickedFor: name,
      });
      taken.add(pmcid);
      picked += 1;
    }
    if (picked < plan.perHardCase) {
      throw new Error(
        `${name}: found ${String(picked)} of ${String(plan.perHardCase)}`,
      );
    }
  }

  if (papers.length > plan.size) {
    throw new Error(
      `the plan's size, ${String(plan.size)}, is less than the ${String(papers.length)} papers its hard cases take`,
    );
  }
  const counts: Record<string, number> = {};
  for (const year of years.values()) counts[year] = (counts[year] ?? 0) + 1;
  const shares = allocate(counts, plan.size - papers.length);
  const order = sample(
    base.map(({ pmcid }) => pmcid),
    plan.seed,
  );
  for (const year of Object.keys(shares).sort()) {
    const fill = order
      .filter((pmcid) => years.get(pmcid) === year && !taken.has(pmcid))
      .slice(0, shares[year]);
    for (const pmcid of fill) {
      papers.push({ pmcid, year, pickedFor: "year" });
      taken.add(pmcid);
    }
  }

  if (papers.length !== plan.size) {
    throw new Error(
      `drew ${String(papers.length)} papers, not the plan's size of ${String(plan.size)}`,
    );
  }

  return {
    papers,
    sheetOrder: sample(
      papers.map(({ pmcid }) => pmcid),
      plan.seed,
    ),
    population: base.length,
  };
}

export const SHEET_COLUMNS = [
  "pmcid",
  "europe_pmc",
  "funded",
  "references_as_written",
  "references_normalised",
  "note",
];

// The owner's labelling sheet: a paper's id and its link, and empty columns
// for the labels. It holds no text from the paper.
export function sheetCsv(pmcids: readonly string[]): string {
  const rows = pmcids.map(
    (pmcid) => `${pmcid},https://europepmc.org/article/PMC/${pmcid},,,,`,
  );
  return [SHEET_COLUMNS.join(","), ...rows, ""].join("\n");
}
