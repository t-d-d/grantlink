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

// A tag name as a pattern that matches only that name, so a name holding a
// regular expression character such as a dot reads as written (#217).
const literal = (name: string): string =>
  name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

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

// Every element with this name, in the order its opening tags come, with the
// attributes in its opening tag, where its content starts and where it ends.
// JATS nests some elements, such as a paragraph in a list item in a
// paragraph. If the name's tags balance, each element ends at the closing tag
// that balances its opening tag, so the elements inside it are part of it
// (#189). If they do not, which closing tag is missing cannot be told, and a
// balanced reading could run an element on past where it ends, into text
// outside it. So then no element holds another of its name: each ends at the
// next opening or closing tag of its name, and one with none after it is
// dropped, so a broken element never takes in the rest of the paper (#263).
// A self-closing element is empty, and is neither a boundary nor ends one
// (#195). Tags match in any case if caseless is set.
function spans(
  xml: string,
  name: string,
  caseless = false,
): { index: number; tag: string; start: number; end: number }[] {
  const tags = [
    ...xml.matchAll(
      new RegExp(
        `<(/?)${literal(name)}${NAME_END}([^>]*)>`,
        caseless ? "giu" : "gu",
      ),
    ),
  ].map((tag) => {
    const [whole, closing, rest = ""] = tag;
    return {
      index: tag.index,
      tag: rest,
      start: tag.index + whole.length,
      kind: rest.endsWith("/") ? "empty" : closing ? "close" : "open",
    };
  });
  const found: { index: number; tag: string; start: number; end: number }[] =
    [];
  const open: { index: number; tag: string; start: number; end: number }[] = [];
  let balanced = true;
  for (const { kind, ...tag } of tags) {
    if (kind === "empty") {
      found.push({ ...tag, end: tag.start });
    } else if (kind === "open") {
      const element = { ...tag, end: -1 };
      found.push(element);
      open.push(element);
    } else {
      const element = open.pop();
      if (element === undefined) balanced = false;
      else element.end = tag.index;
    }
  }
  if (balanced && open.length === 0) return found;
  const bounds = tags.filter(({ kind }) => kind !== "empty");
  return tags.flatMap(({ kind, ...tag }) => {
    if (kind === "close") return [];
    if (kind === "empty") return [{ ...tag, end: tag.start }];
    const next = bounds.find(({ index }) => index > tag.index);
    return [{ ...tag, end: next?.index ?? -1 }];
  });
}

// Every outermost element with this name, as its inner XML, with the
// attributes in its opening tag. One inside another it keeps is read as part
// of that one.
function tagged(
  xml: string,
  name: string,
  attributes = "",
): { tag: string; inner: string }[] {
  const wanted = new RegExp(attributes, "u");
  const found: { tag: string; inner: string }[] = [];
  let until = 0;
  for (const { index, tag, start, end } of spans(xml, name)) {
    if (index < until || !wanted.test(tag)) continue;
    // One that never ends holds the rest of the XML, and is dropped.
    if (end === -1) break;
    found.push({ tag, inner: xml.slice(start, end) });
    until = end;
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

// A <sec-meta>, whole. It can name people, such as in a contributor's <bio>,
// so none of its text is kept, wherever it stands in a part: in an <ack>, in
// a section inside one, or in a subsection of a funding section (#229). A
// self-closing one is only itself. One that is never closed runs to the end
// of the part, since where its names end cannot be told.
const SEC_META_WHOLE = new RegExp(
  String.raw`<sec-meta${NAME_END}(?:[^>]*\/>|[^>]*>[\s\S]*?(?:<\/sec-meta\s*>|$))`,
  "giu",
);

// The paragraphs of a section, or its whole text less its title if it has
// none. A self-closing paragraph is empty, so it does not count. A
// self-closing title strips only itself (#221). Any <sec-meta> is dropped
// first, and leaves a space, so the words either side of it stay apart
// (#229).
function paragraphs(part: string): string[] {
  const section = part.replace(SEC_META_WHOLE, " ");
  const found = elements(section, "p")
    .map(plain)
    .filter((paragraph) => paragraph !== "");
  if (found.length > 0) return found;
  return [plain(section.replace(TITLE, ""))];
}

// What counts as a funding part, read here by the cutter and by the check on
// recorded fixtures (test/fixture-parts.ts), so the two agree (#159).

// A pattern for the attributes of an opening tag, after its name, that holds
// this attribute with one of these values. It steps over each attribute
// before it whole, so it matches only a whole attribute, never part of a
// longer name such as x-fn-type or text inside another attribute's value
// (#217).
function wholeAttribute(name: string, values: string): string {
  const quoted = String.raw`(?:"[^"]*"|'[^']*')`;
  return String.raw`^(?:\s+[^\s=]+\s*=\s*${quoted})*\s+${name}\s*=\s*(?:"(?:${values})"|'(?:${values})')`;
}

// The attribute that marks a footnote as funding text.
export const FUNDING_FOOTNOTE = wholeAttribute(
  "fn-type",
  "financial-disclosure|funding|supported-by",
);

// The start of a funding or acknowledgements section, found by its type or by
// its title. Europe PMC often marks acknowledgements up as a section rather
// than an <ack>, and one journal titles its funding section Support. Support
// must be the whole title, so a body section such as Support vector machines
// is not kept. A tag matches only by its whole name, so <sec-meta> is not a
// section and <title-group> is not a title (#216). A label ends at its own
// closing tag, so a labelled section is not taken for the labelled funding
// section after it. A self-closing label is only itself, so it neither hides
// the funding title after it nor runs on to a later label's closing tag
// (#227). A self-closing section is empty, and a self-closing title names
// nothing, so neither starts a funding section: (?<!\/)> keeps each tag from
// closing itself (#221). A section may open with a <sec-meta>, which is read
// as a label is: to its own closing tag, or only itself when self-closing
// (#227). A <sec-meta> is part of the match whether the section is found by
// its type or its title, so it is not kept, since it can name people (#222).
// Between a section's opening tag, its sec-meta, its label and its title may
// sit white space, comments and processing instructions, and so may they
// inside the title before the words that name it, so neither hides a
// section. The cutter has dropped the comments by then, but the check on
// recorded fixtures reads the raw XML (#230). Each comment or instruction
// ends at its own close, so one cannot run on past a title into another.
const GAP = String.raw`(?:\s|<!--(?:(?!-->)[\s\S])*-->|<\?(?:(?!\?>)[\s\S])*\?>)*`;
const leading = (name: string) =>
  String.raw`(?:<${name}${NAME_END}(?:[^>]*\/>|[^>]*(?<!\/)>(?:(?!<\/${name}>)[\s\S])*<\/${name}>)${GAP})?`;
const SEC_META = leading("sec-meta");
const FUNDING_SECTION_START = String.raw`<sec${NAME_END}(?:[^>]*sec-type="(?:funding|ack|acknowledge?ments?)"[^>]*(?<!\/)>${GAP}${SEC_META}|[^>]*(?<!\/)>${GAP}${SEC_META}${leading("label")}<title${NAME_END}[^>]*(?<!\/)>${GAP}(?:(?:funding|financial support|grant support|acknowledge?ments?)\b|support[\s.:]*<\/title>))`;

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

function fundingBodySections(xml: string): string[] {
  // Tags match in any case, as the pattern that finds the section does.
  const sections = new Map(
    spans(xml, "sec", true).map((section) => [section.index, section]),
  );
  return [...xml.matchAll(FUNDING_SECTION)].flatMap((match) => {
    const start = match.index + match[0].length;
    const end = sections.get(match.index)?.end ?? -1;
    if (end < start) return [];
    // A match found by its title starts part way through the title, so the
    // rest of the title is dropped.
    return [xml.slice(start, end).replace(/^[^<]*<\/title>/u, "")];
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
