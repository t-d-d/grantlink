import type { FundingSections } from "../extract/rules.ts";

// Cuts a paper's full text, in JATS XML as Europe PMC serves it, down to its
// funding statement, its acknowledgements and its funding metadata. Nothing
// else of the paper is kept: not the abstract, the body or the author list.

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/giu,
    (whole, entity: string) => {
      if (entity.startsWith("#")) {
        const code = /^#x/iu.test(entity)
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        // A reference past Unicode's range is left as written.
        return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[entity.toLowerCase()] ?? whole;
    },
  );
}

function plain(xml: string): string {
  return decode(xml.replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .replace(/\s+([.,;:)])/gu, "$1")
    .replace(/\(\s+/gu, "(")
    .trim();
}

// Every element with this name, as its opening tag and its inner XML. JATS
// does not nest any of the elements read here inside one of the same name.
function tagged(
  xml: string,
  name: string,
  attributes = "",
): { tag: string; inner: string }[] {
  const pattern = new RegExp(
    `(<${name}\\b(?=[^>]*${attributes})[^>]*>)([\\s\\S]*?)</${name}>`,
    "gu",
  );
  return [...xml.matchAll(pattern)].map((match) => ({
    tag: match[1] ?? "",
    inner: match[2] ?? "",
  }));
}

// Every element with this name, as its inner XML.
function elements(xml: string, name: string, attributes = ""): string[] {
  return tagged(xml, name, attributes).map(({ inner }) => inner);
}

// An attribute's value split at white space, in either kind of quotes.
function attribute(tag: string, name: string): string[] {
  const match = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "u",
  ).exec(tag);
  const value = match?.[1] ?? match?.[2] ?? "";
  return value.split(/\s+/u).filter((part) => part !== "");
}

// An award group's ids with the funding sources they belong to. An award id
// whose rid names sources in its group goes to those sources alone. Any
// other id goes to every source in the group, which then does not say whose
// it is (#128).
function awardsOf(group: string): FundingSections["awards"] {
  const sources = tagged(group, "funding-source").map(({ tag, inner }) => ({
    ids: attribute(tag, "id"),
    name: plain(inner),
  }));
  const all = sources.map(({ name }) => name);
  const untied: string[] = [];
  const tied = new Map<string, { sources: string[]; ids: string[] }>();
  for (const { tag, inner } of tagged(group, "award-id")) {
    const id = plain(inner);
    const rid = attribute(tag, "rid");
    const named = sources
      .filter((source) => source.ids.some((sourceId) => rid.includes(sourceId)))
      .map(({ name }) => name);
    if (named.length === 0) {
      untied.push(id);
      continue;
    }
    const key = JSON.stringify(named);
    const award = tied.get(key) ?? { sources: named, ids: [] };
    award.ids.push(id);
    tied.set(key, award);
  }
  const awards = [...tied.values()];
  return untied.length > 0 || awards.length === 0
    ? [{ sources: all, ids: untied }, ...awards]
    : awards;
}

// The paragraphs of a section, or its whole text less its title if it has
// none.
function paragraphs(section: string): string[] {
  const found = elements(section, "p").map(plain);
  if (found.length > 0) return found;
  return [plain(section.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gu, ""))];
}

// A funding or acknowledgements section in the body, found by its type or by
// its title. Europe PMC often marks acknowledgements up as a section rather
// than an <ack>, and one journal titles its funding section Support. Support
// must be the whole title, so a body section such as Support vector machines
// is not kept. The match starts at the section's own opening tag, so one
// nested in another section is found too.
const FUNDING_SECTION =
  /<sec\b(?:[^>]*sec-type="(?:funding|ack|acknowledge?ments?)"[^>]*>|[^>]*>\s*(?:<label\b[^>]*>[\s\S]*?<\/label>\s*)?<title\b[^>]*>\s*(?:(?:funding|financial support|grant support|acknowledge?ments?)\b|support[\s.:]*<\/title>))([\s\S]*?)<\/sec>/giu;

function fundingBodySections(xml: string): string[] {
  // A match found by its title starts part way through the title, so the
  // rest of the title is dropped.
  return [...xml.matchAll(FUNDING_SECTION)].map((match) =>
    (match[1] ?? "").replace(/^[^<]*<\/title>/u, ""),
  );
}

export function fundingSections(xml: string): FundingSections {
  const groups = elements(xml, "funding-group");
  const statements = groups.flatMap((group) =>
    elements(group, "funding-statement").map(plain),
  );
  const awards = groups.flatMap((group) =>
    elements(group, "award-group").flatMap(awardsOf),
  );
  const sections = fundingBodySections(xml);
  const text = [
    ...statements,
    ...sections.flatMap(paragraphs),
    ...elements(xml, "ack").flatMap(paragraphs),
    ...elements(
      xml,
      "fn",
      `fn-type="(?:financial-disclosure|funding|supported-by)"`,
    ).flatMap(paragraphs),
  ].filter((paragraph) => paragraph !== "");
  return { text: [...new Set(text)], awards };
}
