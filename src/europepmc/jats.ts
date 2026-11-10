import type { FundingSections } from "../extract/rules.ts";
import {
  attribute,
  descendants,
  fragment,
  outermost,
  readXml,
  serialize,
  type XmlElement,
  type XmlNode,
} from "./xml.ts";

// Cuts a paper's full text, in JATS XML as Europe PMC serves it, down to its
// funding statement, its acknowledgements and its funding metadata. Nothing
// else of the paper is kept: not the abstract, the body or the author list.
// The XML is read through a parser into a tree (#343), so a tag is read as
// XML reads it, whatever its spacing, quotes or nesting.

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

// The text of these nodes, with each element's tags read as a space, so the
// words either side of one stay apart. A comment is dropped unread, and a
// processing instruction reads as a space. An element that fails the test
// reads as a space, with all it holds.
function words(
  nodes: XmlNode[],
  keep: (element: XmlElement) => boolean = () => true,
): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
          return decode(node.text);
        case "cdata":
          return node.text;
        case "comment":
          return "";
        case "instruction":
          return " ";
        case "element":
          return keep(node) ? ` ${words(node.children, keep)} ` : " ";
      }
    })
    .join("");
}

function plain(
  nodes: XmlNode[],
  keep?: (element: XmlElement) => boolean,
): string {
  return words(nodes, keep)
    .replace(/\s+/gu, " ")
    .replace(/\s+([.,;:)])/gu, "$1")
    .replace(/\(\s+/gu, "(")
    .trim();
}

// A tag's name as JATS writes it. A section's own parts match in any case,
// as they always have here (#292).
const named =
  (name: string) =>
  (element: XmlElement): boolean =>
    element.name === name;
const namedInAnyCase =
  (name: string) =>
  (element: XmlNode | undefined): element is XmlElement =>
    element?.kind === "element" && element.name.toLowerCase() === name;
const isTitle = namedInAnyCase("title");
const isLabel = namedInAnyCase("label");
const isSecMeta = namedInAnyCase("sec-meta");
const isSection = namedInAnyCase("sec");

// An attribute's value split at white space.
const valuesOf = (element: XmlElement, name: string): string[] =>
  (attribute(element, name) ?? "").split(/\s+/u).filter((part) => part !== "");

// The funding metadata the cutter reads, by element name. In each funding
// group it reads every funding statement whole, and in each award group every
// funding source and award id whole. The check on recorded fixtures
// (test/fixture-parts.ts) reads a funding group by these names too, so the two
// agree (#305).
export const FUNDING_METADATA = {
  group: "funding-group",
  statement: "funding-statement",
  award: "award-group",
  source: "funding-source",
  id: "award-id",
} as const;

// The elements the cutter reads by their names, in any case. Only these are
// read with care when tags do not balance (#263), so a broken inline
// element, or a broken part of the article around the funding parts, keeps
// its words.
const READ_BY_NAME = new Set<string>([
  "sec",
  "sec-meta",
  "label",
  "title",
  "p",
  "ack",
  "fn",
  ...Object.values(FUNDING_METADATA),
]);

// The XML as the cutter reads it, with care too for the element of this
// name, if one is asked for.
const read = (xml: string, name?: string): XmlElement =>
  readXml(
    xml,
    (found) => found === name || READ_BY_NAME.has(found.toLowerCase()),
  );

// Every outermost element with this name, as its inner XML, written back
// out. One inside another it keeps is read as part of that one.
export function elements(
  xml: string,
  name: string,
  test: (element: XmlElement) => boolean = () => true,
): string[] {
  return outermost(
    read(xml, name),
    (element) => element.name === name && test(element),
  ).map(({ children }) => serialize(children));
}

// An award group's ids with the funding sources they belong to. An award id
// whose rid names sources in its group goes to those sources alone. Any
// other id goes to every source in the group, which then does not say whose
// it is (#128).
function awardsOf(group: XmlElement): FundingSections["awards"] {
  const sources = outermost(group, named(FUNDING_METADATA.source)).map(
    (source) => ({
      ids: valuesOf(source, "id"),
      name: plain(source.children),
    }),
  );
  const all = sources.map(({ name }) => name).filter((name) => name !== "");
  const untied: string[] = [];
  const tied = new Map<string, { sources: string[]; ids: string[] }>();
  for (const award of outermost(group, named(FUNDING_METADATA.id))) {
    const id = plain(award.children);
    if (id === "") continue;
    const rid = valuesOf(award, "rid");
    const sourcesNamed = sources
      .filter((source) => source.ids.some((sourceId) => rid.includes(sourceId)))
      .map(({ name }) => name);
    if (sourcesNamed.length === 0) {
      untied.push(id);
      continue;
    }
    const key = JSON.stringify(sourcesNamed);
    const tiedAward = tied.get(key) ?? { sources: sourcesNamed, ids: [] };
    tiedAward.ids.push(id);
    tied.set(key, tiedAward);
  }
  const awards = [...tied.values()];
  // An award group that names nothing, such as a self-closing one, gives no
  // award.
  if (all.length === 0 && untied.length === 0) return awards;
  return untied.length > 0 || awards.length === 0
    ? [{ sources: all, ids: untied }, ...awards]
    : awards;
}

// The paragraphs of a part, or its whole text less its titles if it has
// none. A self-closing paragraph is empty, so it does not count. A
// <sec-meta> can name people, such as in a contributor's <bio>, so none of
// its text is kept, wherever it stands in a part: in an <ack>, in a section
// inside one, or in a subsection of a funding section (#229).
function paragraphs(part: XmlNode[]): string[] {
  const root = fragment(part);
  const kept = (element: XmlElement): boolean => !isSecMeta(element);
  const found = outermost(
    root,
    (element) => !kept(element) || element.name === "p",
  )
    .filter(kept)
    .map((paragraph) => plain(paragraph.children, kept))
    .filter((paragraph) => paragraph !== "");
  if (found.length > 0) return found;
  return [plain(part, (element) => kept(element) && !isTitle(element))];
}

// What counts as a funding part, read here by the cutter and by the check on
// recorded fixtures (test/fixture-parts.ts), so the two agree (#159).

// Whether any attribute of this name on the element passes the test. An
// attribute written twice is not XML, and either value counts, as before
// #343 (#354).
const anyAttribute = (
  element: XmlElement,
  name: string,
  test: (value: string) => boolean,
): boolean =>
  element.attributes.some((found) => found.name === name && test(found.value));

// Whether a footnote's type marks it as funding text.
export const FUNDING_FOOTNOTE = (element: XmlElement): boolean =>
  anyAttribute(element, "fn-type", (value) =>
    ["financial-disclosure", "funding", "supported-by"].includes(value),
  );

// What sits between a section's opening tag, its sec-meta, its label and its
// title without hiding the section: white space, comments and processing
// instructions (#230).
const isGap = (node: XmlNode | undefined): boolean =>
  node !== undefined &&
  (node.kind === "comment" ||
    node.kind === "instruction" ||
    ((node.kind === "text" || node.kind === "cdata") &&
      node.text.trim() === ""));

const FUNDING_TYPE = /^(?:funding|ack|acknowledge?ments?)$/iu;

// A section title as the list below holds it: in lower case, with all
// punctuation dropped, each run of white space, no-break spaces included, as
// one space, and no space at either end (#239).
export const normaliseTitle = (title: string): string =>
  title.toLowerCase().replace(/\p{P}/gu, "").replace(/\s+/gu, " ").trim();

// The titles that name a funding section, normalised. Europe PMC often marks
// acknowledgements up as a section rather than an <ack>, and one journal
// titles its funding section Support. A title counts only when the whole of
// it is on this list, so a body section such as Funding models for new drugs
// or Support vector machines is not kept (#239). The list holds the headings
// #239 names and the funding and acknowledgement section titles found in
// gold sets A and B.
export const FUNDING_TITLES: ReadonlySet<string> = new Set([
  "funding",
  "funding information",
  "funding statement",
  "funding sources",
  "source of funding",
  "sources of funding",
  "role of the funding source",
  "financial support",
  "grant support",
  "support",
  "acknowledgement",
  "acknowledgements",
  "acknowledgment",
  "acknowledgments",
  "acknowledgements and funding",
  "funding and acknowledgements",
  // The joined headings in the other spelling, as the single words have.
  "acknowledgments and funding",
  "funding and acknowledgments",
  // Found in gold sets A and B.
  "funding and organization",
  "grants",
  "role of funders",
  "role of funding source",
  // Role of the funder/sponsor, with its slash dropped.
  "role of the fundersponsor",
]);

const isFundingTitle = (title: string): boolean =>
  FUNDING_TITLES.has(normaliseTitle(title));

// What a funding section holds after its heading, or undefined if the
// element is not one. A section is found by its type or by its title, and
// may open with a <sec-meta> and then a label before its title. Its
// <sec-meta> is not part of what it holds, since it can name people (#222).
// A self-closing section is empty, and a self-closing title names nothing,
// so neither makes a funding section (#221). The title is read as text, so
// inline markup around its words does not hide it (#240).
function fundingContent(section: XmlElement): XmlNode[] | undefined {
  if (!isSection(section) || section.empty) return undefined;
  const children = section.children;
  let at = 0;
  const skipGaps = () => {
    while (isGap(children[at])) at += 1;
  };
  skipGaps();
  if (isSecMeta(children[at])) {
    at += 1;
    skipGaps();
  }
  if (anyAttribute(section, "sec-type", (value) => FUNDING_TYPE.test(value))) {
    return children.slice(at);
  }
  if (isLabel(children[at])) {
    at += 1;
    skipGaps();
  }
  const title = children[at];
  if (!isTitle(title) || title.empty) return undefined;
  return isFundingTitle(plain(title.children))
    ? children.slice(at + 1)
    : undefined;
}

// Whether the element is a funding section.
export const isFundingSection = (element: XmlElement): boolean =>
  fundingContent(element) !== undefined;

// Whether the section whose opening tag starts at this index of the XML is a
// funding section.
export function isFundingSectionAt(xml: string, index: number): boolean {
  for (const element of descendants(read(xml))) {
    if (element.start === index) return isFundingSection(element);
  }
  return false;
}

export function fundingSections(paper: string): FundingSections {
  const tree = read(paper);
  const groups = outermost(tree, named(FUNDING_METADATA.group));
  const statements = groups.flatMap((group) =>
    outermost(group, named(FUNDING_METADATA.statement)).map((statement) =>
      plain(statement.children),
    ),
  );
  const awards = groups.flatMap((group) =>
    outermost(group, named(FUNDING_METADATA.award)).flatMap(awardsOf),
  );
  // Every funding section, wherever it is, so one nested in another section
  // is found too.
  const sections = [...descendants(tree)].flatMap((element) => {
    const content = fundingContent(element);
    return content === undefined ? [] : [content];
  });
  const text = [
    ...statements,
    ...sections.flatMap(paragraphs),
    ...outermost(tree, named("ack")).flatMap(({ children }) =>
      paragraphs(children),
    ),
    ...outermost(
      tree,
      (element) => element.name === "fn" && FUNDING_FOOTNOTE(element),
    ).flatMap(({ children }) => paragraphs(children)),
  ].filter((paragraph) => paragraph !== "");
  return { text: [...new Set(text)], awards };
}
