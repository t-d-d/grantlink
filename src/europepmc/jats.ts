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
// of its name (#195). The name must end at whitespace, a slash or the tag's
// close: \b would let "fn" match <fn-group>, since a hyphen ends a word.
export function elements(xml: string, name: string, attributes = ""): string[] {
  const tags = new RegExp(`<(/?)${name}(?=[\\s/>])([^>]*)>`, "gu");
  const wanted = new RegExp(attributes, "u");
  const found: string[] = [];
  let depth = 0;
  let start = 0;
  for (const tag of xml.matchAll(tags)) {
    const [whole, closing, rest = ""] = tag;
    if (rest.endsWith("/")) {
      if (depth === 0 && wanted.test(rest)) found.push("");
      continue;
    }
    if (closing) {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0) found.push(xml.slice(start, tag.index));
    } else if (depth > 0) {
      depth += 1;
    } else if (wanted.test(rest)) {
      depth = 1;
      start = tag.index + whole.length;
    }
  }
  if (depth > 0) {
    const close = xml.indexOf(`</${name}>`, start);
    if (close !== -1) {
      found.push(xml.slice(start, close));
      return [
        ...found,
        ...elements(xml.slice(close + name.length + 3), name, attributes),
      ];
    }
  }
  return found;
}

// The paragraphs of a section, or its whole text less its title if it has
// none. A self-closing paragraph is empty, so it does not count. A
// self-closing title strips only itself (#221).
function paragraphs(section: string): string[] {
  const found = elements(section, "p")
    .map(plain)
    .filter((paragraph) => paragraph !== "");
  if (found.length > 0) return found;
  return [
    plain(
      section.replace(/<title\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/title>)/gu, ""),
    ),
  ];
}

// What counts as a funding part, read here by the cutter and by the check on
// recorded fixtures (test/fixture-parts.ts), so the two agree (#159).

// The attribute that marks a footnote as funding text.
export const FUNDING_FOOTNOTE = String.raw`\bfn-type="(?:financial-disclosure|funding|supported-by)"`;

// The start of a funding or acknowledgements section, found by its type or by
// its title. Europe PMC often marks acknowledgements up as a section rather
// than an <ack>, and one journal titles its funding section Support. Support
// must be the whole title, so a body section such as Support vector machines
// is not kept. A label ends at its own closing tag, so a labelled section
// is not taken for the labelled funding section after it. A self-closing
// section is empty, and a self-closing title names nothing, so neither
// starts a funding section: (?<!\/)> keeps each tag from closing itself
// (#221).
const FUNDING_SECTION_START = String.raw`<sec\b(?:[^>]*sec-type="(?:funding|ack|acknowledge?ments?)"[^>]*(?<!\/)>|[^>]*(?<!\/)>\s*(?:<label\b[^>]*>(?:(?!<\/label>)[\s\S])*<\/label>\s*)?<title\b[^>]*(?<!\/)>\s*(?:(?:funding|financial support|grant support|acknowledge?ments?)\b|support[\s.:]*<\/title>))`;

const FUNDING_SECTION_AT = new RegExp(FUNDING_SECTION_START, "iuy");

// Whether the section that opens at this index of the XML is a funding
// section.
export function isFundingSectionAt(xml: string, index: number): boolean {
  FUNDING_SECTION_AT.lastIndex = index;
  return FUNDING_SECTION_AT.test(xml);
}

// Every funding section, wherever it is. The match starts at the section's
// own opening tag, so one nested in another section is found too.
const FUNDING_SECTION = new RegExp(
  String.raw`${FUNDING_SECTION_START}([\s\S]*?)<\/sec>`,
  "giu",
);

function fundingBodySections(xml: string): string[] {
  // A match found by its title starts part way through the title, so the
  // rest of the title is dropped.
  return [...xml.matchAll(FUNDING_SECTION)].map((match) =>
    (match[1] ?? "").replace(/^[^<]*<\/title>/u, ""),
  );
}

export function fundingSections(paper: string): FundingSections {
  const xml = markup(paper);
  const groups = elements(xml, "funding-group");
  const statements = groups.flatMap((group) =>
    elements(group, "funding-statement").map(plain),
  );
  const awards = groups
    .flatMap((group) =>
      elements(group, "award-group").map((award) => ({
        source: elements(award, "funding-source").map(plain).join("; "),
        ids: elements(award, "award-id")
          .map(plain)
          .filter((id) => id !== ""),
      })),
    )
    // An empty award group, such as a self-closing one, names nothing.
    .filter(({ source, ids }) => source !== "" || ids.length > 0);
  const sections = fundingBodySections(xml);
  const text = [
    ...statements,
    ...sections.flatMap(paragraphs),
    ...elements(xml, "ack").flatMap(paragraphs),
    ...elements(xml, "fn", FUNDING_FOOTNOTE).flatMap(paragraphs),
  ].filter((paragraph) => paragraph !== "");
  return { text: [...new Set(text)], awards };
}
