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

// What ends a tag's name: whitespace, a slash or the tag's close. \b would
// let "fn" match <fn-group> and "title" match <title-group>, since a hyphen
// ends a word (#210, #216).
const NAME_END = String.raw`(?=[\s/>])`;

// Drops comments and turns each CDATA section into escaped text, so that a
// tag written inside either is not read as markup.
function markup(xml: string): string {
  return xml
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, (_whole, text: string) =>
      text
        .replace(/&/gu, "&amp;")
        .replace(/</gu, "&lt;")
        .replace(/>/gu, "&gt;"),
    );
}

// Every outermost element with this name, as its inner XML. JATS nests some
// of them, such as a paragraph in a list item in a paragraph, so each one
// runs to the closing tag that balances its opening tag, and the elements
// inside it are read as part of it. One whose closing tag is missing runs
// only to the next closing tag of its name, and one with none after it is
// dropped, so a broken element never takes in the rest of the paper. A
// self-closing element is empty, and does not run on to the next closing tag
// of its name (#195). Each comes with the attributes in its opening tag.
function tagged(
  xml: string,
  name: string,
  attributes = "",
): { tag: string; inner: string }[] {
  const tags = new RegExp(`<(/?)${name}${NAME_END}([^>]*)>`, "gu");
  const wanted = new RegExp(attributes, "u");
  const found: { tag: string; inner: string }[] = [];
  let opening = "";
  let depth = 0;
  let start = 0;
  for (const tag of xml.matchAll(tags)) {
    const [whole, closing, rest = ""] = tag;
    if (rest.endsWith("/")) {
      if (depth === 0 && wanted.test(rest))
        found.push({ tag: rest, inner: "" });
      continue;
    }
    if (closing) {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0) {
        found.push({ tag: opening, inner: xml.slice(start, tag.index) });
      }
    } else if (depth > 0) {
      depth += 1;
    } else if (wanted.test(rest)) {
      depth = 1;
      opening = rest;
      start = tag.index + whole.length;
    }
  }
  if (depth > 0) {
    const close = xml.indexOf(`</${name}>`, start);
    if (close !== -1) {
      found.push({ tag: opening, inner: xml.slice(start, close) });
      return [
        ...found,
        ...tagged(xml.slice(close + name.length + 3), name, attributes),
      ];
    }
  }
  return found;
}

// Every outermost element with this name, as its inner XML.
export function elements(xml: string, name: string, attributes = ""): string[] {
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
  const all = sources.map(({ name }) => name).filter((name) => name !== "");
  const untied: string[] = [];
  const tied = new Map<string, { sources: string[]; ids: string[] }>();
  for (const { tag, inner } of tagged(group, "award-id")) {
    const id = plain(inner);
    if (id === "") continue;
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
  // An award group that names nothing, such as a self-closing one, gives no
  // award.
  if (all.length === 0 && untied.length === 0) return awards;
  return untied.length > 0 || awards.length === 0
    ? [{ sources: all, ids: untied }, ...awards]
    : awards;
}

// A section's title. A self-closing title is only itself (#221).
const TITLE = new RegExp(
  String.raw`<title${NAME_END}(?:[^>]*\/>|[^>]*>[\s\S]*?<\/title>)`,
  "gu",
);

// The paragraphs of a section, or its whole text less its title if it has
// none. A self-closing paragraph is empty, so it does not count. A
// self-closing title strips only itself (#221).
function paragraphs(section: string): string[] {
  const found = elements(section, "p")
    .map(plain)
    .filter((paragraph) => paragraph !== "");
  if (found.length > 0) return found;
  return [plain(section.replace(TITLE, ""))];
}

// What counts as a funding part, read here by the cutter and by the check on
// recorded fixtures (test/fixture-parts.ts), so the two agree (#159).

// The attribute that marks a footnote as funding text.
export const FUNDING_FOOTNOTE = String.raw`\bfn-type="(?:financial-disclosure|funding|supported-by)"`;

// The start of a funding or acknowledgements section, found by its type or by
// its title. Europe PMC often marks acknowledgements up as a section rather
// than an <ack>, and one journal titles its funding section Support. Support
// must be the whole title, so a body section such as Support vector machines
// is not kept. A tag matches only by its whole name, so <sec-meta> is not a
// section and <title-group> is not a title (#216). A label ends at its own
// closing tag, so a labelled section is not taken for the labelled funding
// section after it. A self-closing section is empty, and a self-closing
// title names nothing, so neither starts a funding section: (?<!\/)> keeps
// each tag from closing itself (#221). A section may open with a <sec-meta>,
// which ends at its own closing tag as a label does. It is part of the match
// whether the section is found by its type or its title, so it is not kept,
// since it can name people (#222).
const SEC_META = String.raw`(?:<sec-meta${NAME_END}(?:[^>]*\/>|[^>]*>(?:(?!<\/sec-meta>)[\s\S])*<\/sec-meta>)\s*)?`;
const FUNDING_SECTION_START = String.raw`<sec${NAME_END}(?:[^>]*sec-type="(?:funding|ack|acknowledge?ments?)"[^>]*(?<!\/)>\s*${SEC_META}|[^>]*(?<!\/)>\s*${SEC_META}(?:<label${NAME_END}[^>]*>(?:(?!<\/label>)[\s\S])*<\/label>\s*)?<title${NAME_END}[^>]*(?<!\/)>\s*(?:(?:funding|financial support|grant support|acknowledge?ments?)\b|support[\s.:]*<\/title>))`;

const FUNDING_SECTION_AT = new RegExp(FUNDING_SECTION_START, "iuy");

// Whether the section that opens at this index of the XML is a funding
// section.
export function isFundingSectionAt(xml: string, index: number): boolean {
  FUNDING_SECTION_AT.lastIndex = index;
  return FUNDING_SECTION_AT.test(xml);
}

// Every funding section, wherever it is. The match starts at the section's
// own opening tag, so one nested in another section is found too.
const FUNDING_SECTION = new RegExp(FUNDING_SECTION_START, "giu");

// Where the element whose content starts at this index ends: at the closing
// tag that balances its opening tag, so a subsection's closing tag does not
// end it (#189). One that is never balanced ends at the next closing tag of
// its name, as in tagged, and one with none after it is dropped. Tags match
// in any case, as the pattern that finds the section does.
function closeOf(xml: string, name: string, from: number): number {
  const tags = new RegExp(`<(/?)${name}${NAME_END}([^>]*)>`, "giu");
  tags.lastIndex = from;
  let depth = 1;
  for (let tag = tags.exec(xml); tag !== null; tag = tags.exec(xml)) {
    const [, closing, rest = ""] = tag;
    if (rest.endsWith("/")) continue;
    depth += closing ? -1 : 1;
    if (depth === 0) return tag.index;
  }
  const next = new RegExp(`</${name}>`, "giu");
  next.lastIndex = from;
  return next.exec(xml)?.index ?? -1;
}

function fundingBodySections(xml: string): string[] {
  return [...xml.matchAll(FUNDING_SECTION)].flatMap((match) => {
    const start = match.index + match[0].length;
    const close = closeOf(xml, "sec", start);
    if (close === -1) return [];
    // A match found by its title starts part way through the title, so the
    // rest of the title is dropped.
    return [xml.slice(start, close).replace(/^[^<]*<\/title>/u, "")];
  });
}

export function fundingSections(paper: string): FundingSections {
  const xml = markup(paper);
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
    ...elements(xml, "fn", FUNDING_FOOTNOTE).flatMap(paragraphs),
  ].filter((paragraph) => paragraph !== "");
  return { text: [...new Set(text)], awards };
}
