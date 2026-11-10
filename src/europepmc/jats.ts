import { type FundingSections, namesFunder } from "../extract/rules.ts";
import {
  attribute,
  descendants,
  fragment,
  outermost,
  readXml,
  type XmlElement,
  type XmlNode,
} from "./xml.ts";

// Cuts a paper's full text, in JATS XML as Europe PMC serves it, down to its
// funding metadata, its acknowledgements and its funding sections, notes and
// footnotes. From the funding metadata it keeps the funding statements and
// each award's funding sources and award ids. A section is found by its type
// or its title (#239), and a note or footnote by its type or its title, or,
// with neither, by the funder it names, a footnote only in a footnote group
// (#505). An <ack> and a funding section keep only their untitled and
// funding subsections, and the notes and footnotes in them that have no
// type or title (#563, #584). Nothing else of the paper is kept: not the
// abstract, the rest of the body or the author list.
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
// A section's <sec-meta> can name people (#222), so the cutter drops every
// one it reads, matched by this name in any case. The check on recorded
// fixtures (test/fixture-parts.ts) names one by this test too, so the two
// agree (#472).
const SEC_META = "sec-meta";
export const isSecMetaName = (name: string): boolean =>
  name.toLowerCase() === SEC_META;
const isSecMeta = (element: XmlNode | undefined): element is XmlElement =>
  element?.kind === "element" && isSecMetaName(element.name);
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
  SEC_META,
  "label",
  "title",
  "p",
  "ack",
  "fn",
  "notes",
  ...Object.values(FUNDING_METADATA),
]);

// The XML as the cutter reads it.
const read = (xml: string): XmlElement =>
  readXml(xml, (found) => READ_BY_NAME.has(found.toLowerCase()));

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

// What sits between a section's opening tag, its sec-meta, its label and its
// title without hiding the section: white space, comments and processing
// instructions (#230).
const isGap = (node: XmlNode | undefined): boolean =>
  node !== undefined &&
  (node.kind === "comment" ||
    node.kind === "instruction" ||
    ((node.kind === "text" || node.kind === "cdata") &&
      node.text.trim() === ""));

// The attribute that holds a section's type.
const SECTION_TYPE = "sec-type";

// The section types that mark a section as funding text. The check on
// recorded fixtures expects these values too (#417).
export const FUNDING_SECTION_TYPE = /^(?:funding|ack|acknowledge?ments?)$/iu;

// A section title as the list below holds it: in lower case, with "&" read
// as "and" and every other mark of punctuation as a space, each run of white
// space, no-break spaces included, as one space, and no space at either end
// (#239). So Role of the funder/sponsor and Role of the funder / sponsor
// read the same.
export const normaliseTitle = (title: string): string =>
  title
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/\p{P}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

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
  "acknowledgments and funding",
  "funding and acknowledgments",
  // Headings the old match on a title's first words kept, which no gold
  // paper uses.
  "funding source",
  "financial support and sponsorship",
  "funding sources and disclosures",
  "acknowledgements and disclosures",
  "acknowledgments and disclosures",
  // Found in gold sets A and B.
  "funding and organization",
  "grants",
  "role of funders",
  "role of funding source",
  "role of the funder sponsor",
]);

const isFundingTitle = (title: string): boolean =>
  FUNDING_TITLES.has(normaliseTitle(title));

// Where the next node that is not a gap stands, from this one on.
const pastGaps = (children: XmlNode[], from: number): number => {
  let at = from;
  while (isGap(children[at])) at += 1;
  return at;
};

// Where a section's heading starts: past a <sec-meta>, if it opens with one.
const headingStart = (section: XmlElement): number => {
  const at = pastGaps(section.children, 0);
  return isSecMeta(section.children[at])
    ? pastGaps(section.children, at + 1)
    : at;
};

// The text of the title that stands here, after a label if there is one,
// and where it stands, or undefined if there is none. A self-closing title
// names nothing (#221), and neither does one whose text is empty or blank,
// as a blank type says nothing (#600), or one of punctuation alone, which
// normalises to nothing as the funding titles are matched (#614).
function titleFrom(
  children: XmlNode[],
  from: number,
): { text: string; at: number } | undefined {
  const at = isLabel(children[from]) ? pastGaps(children, from + 1) : from;
  const title = children[at];
  if (!isTitle(title) || title.empty) return undefined;
  const text = plain(title.children);
  return normaliseTitle(text) === "" ? undefined : { text, at };
}

// What a funding section holds after its heading, or undefined if the
// element is not one. A section is found by its type or by its title, and
// may open with a <sec-meta> and then a label before its title. Its
// <sec-meta> is not part of what it holds, since it can name people (#222).
// A self-closing section is empty, and a self-closing, empty or blank title,
// or one of punctuation alone, names nothing, so neither makes a funding
// section (#221, #600, #614). The title is read as text, so inline markup
// around its words does not hide it (#240).
function fundingContent(section: XmlElement): XmlNode[] | undefined {
  if (!isSection(section) || section.empty) return undefined;
  const children = section.children;
  const start = headingStart(section);
  if (
    anyAttribute(section, SECTION_TYPE, (value) =>
      FUNDING_SECTION_TYPE.test(value),
    )
  ) {
    return children.slice(start);
  }
  const found = titleFrom(children, start);
  if (found === undefined) return undefined;
  return isFundingTitle(found.text) ? children.slice(found.at + 1) : undefined;
}

// Whether the element is a funding section.
export const isFundingSection = (element: XmlElement): boolean =>
  fundingContent(element) !== undefined;

// The note and footnote types that mark one as funding text. The check on
// recorded fixtures expects these values too (#417). Europe PMC writes
// funding-information on a back-matter note (#505).
export const FUNDING_NOTE_TYPES: readonly string[] = Object.freeze([
  "financial-disclosure",
  "funding",
  "funding-information",
  "supported-by",
]);

// The attribute that holds the type of a note or a footnote, by its name.
const NOTE_TYPE: Readonly<Record<string, string>> = Object.freeze({
  fn: "fn-type",
  notes: "notes-type",
});

// These nodes less every element at any depth that fails the test, with
// all it holds.
const pruned = (
  nodes: XmlNode[],
  keep: (element: XmlElement) => boolean,
): XmlNode[] =>
  nodes.flatMap((node): XmlNode[] => {
    if (node.kind !== "element") return [node];
    return keep(node)
      ? [{ ...node, children: pruned(node.children, keep) }]
      : [];
  });

// Whether a section says what it is about: by a title, which may follow a
// <sec-meta> and a label, or by a type that is not empty, which counts as a
// title here (#563).
const saysWhatItIs = (section: XmlElement): boolean =>
  titleFrom(section.children, headingStart(section)) !== undefined ||
  anyAttribute(section, SECTION_TYPE, (value) => value.trim() !== "");

// Whether a section inside a funding part is read with it: an element that
// is not a section, an untitled section and a funding section are. A
// section titled or typed as something else, such as author contributions,
// is about that, and is left out with all it holds (#541, #563).
const keptInFundingPart = (element: XmlElement): boolean =>
  !isSection(element) || !saysWhatItIs(element) || isFundingSection(element);

// What a funding section or an <ack> holds that is read with it, at any
// depth: all but its sections and its notes and footnotes titled or typed as
// something other than funding (#563, #584). A note or footnote titled or
// typed as funding is left out too, and read on its own. An untitled,
// untyped one is kept, as an untitled section is, since a footnote outside
// a footnote group is never read by its own words. An <ack> is cut as a
// section typed ack is, so the two markups of acknowledgements agree.
const sectionContent = (content: XmlNode[]): XmlNode[] =>
  pruned(
    content,
    (element) => keptInFundingPart(element) && !noteSaysWhatItIs(element),
  );

// The notes and footnotes inside a note, at any depth, which are read, or
// left out, on their own (#563).
const NOTES_WITHIN = new Set(["notes", "fn-group", "fn"]);

// What a note or footnote holds that is read with it: all but the notes
// and footnotes inside a note, and any section in it, at any depth, titled
// or typed as something other than funding (#541, #563). A footnote keeps
// the notes it holds.
const noteContent = (note: XmlElement): XmlNode[] =>
  pruned(
    note.children,
    (element) =>
      keptInFundingPart(element) &&
      !(note.name === "notes" && NOTES_WITHIN.has(element.name)),
  );

// A note's own content: what it holds that is read with it, less the
// sections it holds directly (#526). A section deeper in, wrapped in
// another element, is left out when its title or type names something
// other than funding, as in a marked note (#541, #563).
const ownContent = (note: XmlElement): XmlNode[] =>
  noteContent(note).filter(
    (child) => child.kind !== "element" || !isSection(child),
  );

// Whether a note or a footnote says what it is about, by a title or by a
// type that is not empty (#584).
const noteSaysWhatItIs = (element: XmlElement): boolean => {
  const type = NOTE_TYPE[element.name];
  return (
    type !== undefined &&
    (noteTitle(element) !== undefined ||
      anyAttribute(element, type, (value) => value.trim() !== ""))
  );
};

// A note's own words, which it is read by when it has no type or title.
const ownWords = (note: XmlElement): string => plain(ownContent(note));

// A note's title, which may follow a label, or undefined if it has none. A
// self-closing, empty or blank title, or one of punctuation alone, names
// nothing, as in a section (#221, #600, #614).
function noteTitle(note: XmlElement): string | undefined {
  const children = note.children;
  const found = titleFrom(children, pastGaps(children, 0));
  return found?.text;
}

// Whether a note or a footnote is funding text (#505), and why: "marked"
// when its type or title says so, "own-words" when it has neither and its
// own words name the funder, or undefined if it is not funding text. A
// footnote is read by its own words only in a footnote group: a table
// footnote, an author note or a contributor's footnote names the funder as
// a place or a trial. A note or footnote that has a type or a title is
// judged by those alone, so competing interests that name the funder are
// left out. An empty type says nothing. The parent is the name of the
// element the note stands in.
type FundingNoteKind = "marked" | "own-words";
function fundingNoteKind(
  element: XmlElement,
  parent: string,
): FundingNoteKind | undefined {
  const type = NOTE_TYPE[element.name];
  if (type === undefined) return undefined;
  if (
    anyAttribute(element, type, (value) => FUNDING_NOTE_TYPES.includes(value))
  )
    return "marked";
  const title = noteTitle(element);
  if (title !== undefined) return isFundingTitle(title) ? "marked" : undefined;
  if (anyAttribute(element, type, (value) => value.trim() !== ""))
    return undefined;
  if (element.name === "fn" && parent !== "fn-group") return undefined;
  return namesFunder(ownWords(element)) ? "own-words" : undefined;
}

export const isFundingNote = (element: XmlElement, parent: string): boolean =>
  fundingNoteKind(element, parent) !== undefined;

// What the cut keeps of each funding note and footnote, at any depth, so
// one nested in a note that is not about funding is found too. One marked
// as funding by its type or title is read whole, less the notes inside it
// and its sections titled or typed as something other than funding (#541,
// #563). One kept for its own words is about funding only in those words,
// so the sections it holds directly are left out: author contributions or
// a data statement there name people or say nothing of funding. A funding
// section among them is found by its type or title, as every funding
// section is (#526). A section wrapped in another element inside the note
// is kept with the note's words, unless its title or type names something
// other than funding, as in a marked note (#565).
const fundingNoteParts = (element: XmlElement): XmlNode[][] =>
  element.children.flatMap((child) => {
    if (child.kind !== "element") return [];
    const kind = fundingNoteKind(child, element.name);
    const part =
      kind === undefined
        ? []
        : [kind === "own-words" ? ownContent(child) : noteContent(child)];
    return [...part, ...fundingNoteParts(child)];
  });

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
  // is found too. Each keeps only what is read with it (#563).
  const sections = [...descendants(tree)].flatMap((element) => {
    const content = fundingContent(element);
    return content === undefined ? [] : [sectionContent(content)];
  });
  const text = [
    ...statements,
    ...sections.flatMap(paragraphs),
    ...outermost(tree, named("ack")).flatMap(({ children }) =>
      paragraphs(sectionContent(children)),
    ),
    ...fundingNoteParts(tree).flatMap(paragraphs),
  ].filter((paragraph) => paragraph !== "");
  return { text: [...new Set(text)], awards };
}
