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

// Every element with this name, as its inner XML. JATS does not nest any of
// the elements read here inside one of the same name. A self-closing element
// is empty, and does not run on to the next closing tag of its name (#195).
function elements(xml: string, name: string, attributes = ""): string[] {
  const pattern = new RegExp(
    `<${name}\\b(?=[^>]*${attributes})(?:[^>]*/>|[^>]*>([\\s\\S]*?)</${name}>)`,
    "gu",
  );
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? "");
}

// The paragraphs of a section, or its whole text less its title if it has
// none. A self-closing paragraph is empty, so it does not count.
function paragraphs(section: string): string[] {
  const found = elements(section, "p")
    .map(plain)
    .filter((paragraph) => paragraph !== "");
  if (found.length > 0) return found;
  return [
    plain(section.replace(/<title(?=[\s/>])[^>]*>[\s\S]*?<\/title>/gu, "")),
  ];
}

// A funding or acknowledgements section in the body, found by its type or by
// its title. Europe PMC often marks acknowledgements up as a section rather
// than an <ack>, and one journal titles its funding section Support. Support
// must be the whole title, so a body section such as Support vector machines
// is not kept. A tag matches only by its whole name, so <sec-meta> is not a
// section and <title-group> is not a title (#216). The match starts at the
// section's own opening tag, so one nested in another section is found too.
const FUNDING_SECTION =
  /<sec(?=[\s/>])(?:[^>]*sec-type="(?:funding|ack|acknowledge?ments?)"[^>]*>|[^>]*>\s*(?:<label(?=[\s/>])[^>]*>[\s\S]*?<\/label>\s*)?<title(?=[\s/>])[^>]*>\s*(?:(?:funding|financial support|grant support|acknowledge?ments?)\b|support[\s.:]*<\/title>))([\s\S]*?)<\/sec>/giu;

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
    ...elements(
      xml,
      "fn",
      `fn-type="(?:financial-disclosure|funding|supported-by)"`,
    ).flatMap(paragraphs),
  ].filter((paragraph) => paragraph !== "");
  return { text: [...new Set(text)], awards };
}
