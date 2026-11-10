// What a full text recorded from a paper may keep (#140,
// docs/constraints/personal-data.md). The cut keeps the paper's ids, its
// licence, its funding metadata, its acknowledgements and its funding
// sections and footnotes. Anything else, such as the author list, the
// affiliations, the title, the abstract, the reference list or the body, can
// carry real names, and is named here.
//
// Whether a section or footnote is a funding part is decided by the
// definitions the cutter in src/europepmc/jats.ts exports, so the two agree
// (#159). Inside a part it allows, the check names anything the cutter does
// not read but one title and one label, each holding only its own text
// (#215). Inside the funding metadata it names anything the cutter does not
// read: a funding group may hold its funding statements and award groups,
// and an award group its funding sources and award ids, so a principal award
// recipient or investigator, which names people, is named (#275). The check
// takes those names from the cutter too, so it follows when the cutter reads
// another (#305). Three
// differences stay, where the check is stricter than the cutter. The cutter
// finds a funding section nested in another section, but the check refuses
// the outer section, whose other parts can carry names: a recording keeps
// only the funding section, moved up into the body or the back. In a part
// with no paragraphs the cutter reads the whole text, but the check names
// any element there other than a label, a title or an empty paragraph. And
// the cutter finds a funding statement, funding source or award id at any
// depth in its group, but the check names one anywhere but its own place.
//
// The cutter reads no attribute values but the ids and types it matches on,
// so a value can keep a name nobody reads. On every element a recording
// keeps, the check names each attribute it does not expect, or whose value
// it does not expect (#304). It names the attribute, never its value.

import {
  FUNDING_FOOTNOTE,
  FUNDING_FOOTNOTE_TYPES,
  FUNDING_METADATA,
  FUNDING_SECTION_TYPE,
  isFundingSection as isFundingSectionElement,
} from "../src/europepmc/jats.ts";
import { parseXml, type XmlElement } from "../src/europepmc/xml.ts";

interface Attribute {
  name: string;
  value: string;
}

interface Element {
  name: string;
  attributes: Attribute[];
  // Whether its opening tag holds text that is not an attribute in quotes,
  // or its closing tag holds any text.
  malformed: boolean;
  children: Element[];
  text: boolean;
  // Whether it holds a comment or a processing instruction with text, which
  // the cutter drops unread.
  unread: boolean;
  // Whether the cutter reads the element as a funding section or footnote.
  funding: boolean;
}

// The funding metadata the cutter reads, by the names it reads them by, and
// where a funding group stands in a recorded full text (#305).
const { group, statement, award, source, id } = FUNDING_METADATA;
const GROUP = `article/front/article-meta/${group}`;

const isFundingSection = (element: Element): boolean =>
  element.name === "sec" && element.funding;
const isFundingFootnote = (element: Element): boolean =>
  element.name === "fn" && element.funding;

// For each element whose children are checked, which children it may hold.
// The children of an element allowed here, but not listed, are not checked,
// but a comment or a processing instruction with text anywhere inside it is
// named, since the cutter drops it unread (#303).
const ALLOWED: Record<string, (child: Element) => boolean> = {
  article: (child) => ["front", "body", "back"].includes(child.name),
  "article/front": (child) => child.name === "article-meta",
  "article/front/article-meta": (child) =>
    ["article-id", "permissions", group].includes(child.name),
  "article/front/article-meta/permissions": (child) => child.name === "license",
  [GROUP]: (child) => child.name === statement || child.name === award,
  [`${GROUP}/${award}`]: (child) => child.name === source || child.name === id,
  "article/body": isFundingSection,
  "article/back": (child) =>
    child.name === "ack" ||
    child.name === "fn-group" ||
    isFundingSection(child) ||
    isFundingFootnote(child),
  "article/back/fn-group": isFundingFootnote,
};

// The XML's elements as a tree, under a root with no name, read through the
// parser the cutter reads with (#343), in any case as the cutter reads it, so
// a closing tag ends the same element for both (#415). The check reads the
// tree as parsed, before the cutter's care with tags that do not balance, so
// nothing the cutter would drop from a broken element is hidden from it.
// Declarations are dropped. CDATA and comments count as text, since a
// comment can hold a cut part kept by mistake. So does what a processing
// instruction holds after its target, other than the XML declaration's
// before the root, and what one holds that never ends with ?>, which the
// parser reads as text (#303).
function parse(xml: string): Element {
  const convert = (node: XmlElement, root: boolean): Element => {
    const element: Element = {
      name: node.name,
      attributes: node.attributes,
      malformed: node.malformed,
      children: [],
      text: false,
      unread: false,
      funding:
        (node.name === "sec" && isFundingSectionElement(node)) ||
        (node.name === "fn" && FUNDING_FOOTNOTE(node)),
    };
    for (const child of node.children) {
      switch (child.kind) {
        case "element":
          element.children.push(convert(child, false));
          break;
        case "instruction": {
          const declaration =
            child.target.toLowerCase() === "xml" &&
            root &&
            element.children.length === 0;
          if (!declaration && child.data.trim() !== "") {
            element.text = true;
            element.unread = true;
          }
          break;
        }
        default:
          if (child.text.trim() !== "") {
            element.text = true;
            if (child.kind === "comment") element.unread = true;
          }
      }
    }
    return element;
  };
  return convert(parseXml(xml, { anyCase: true }), true);
}

// What a funding part may hold: its paragraphs, which the cutter reads, and
// a label and a title to head it. The cutter skips the title, and the label
// too when the part has paragraphs, but a title is how a section is found by
// its title, and both are headings, not places for names. Anything else
// inside the part, such as a contributor group, a list or a nested section,
// is named, even in a part with no paragraphs, whose whole text the cutter
// reads: a recording keeps the funding text as paragraphs. Text beside the
// paragraphs is named too, since the cutter reads only the paragraphs. A
// funding section's <sec-meta>, which the cutter skips and which can name
// people (#222), is named with the rest (#215). So is one in the
// acknowledgements, and a section inside them is named whole, with any
// <sec-meta> it holds, though the cutter now drops every <sec-meta> it reads
// (#229). One inside a paragraph is named too, at any depth (#416).
const PART_CHILDREN = ["p", "title", "label"];

const hasText = (element: Element): boolean =>
  element.text || element.children.some(hasText);

// A comment or a processing instruction with text anywhere in a part is
// named, even in a part with no paragraphs, whose other text the cutter
// reads: the cutter drops both, so what one holds is kept without being read
// (#230, #303).
const hasUnread = (element: Element): boolean =>
  element.unread || element.children.some(hasUnread);

// Whether the cutter reads the element as a funding part: a funding section,
// a funding footnote or the acknowledgements. Where each may stand is for
// ALLOWED to say.
const isPart = (element: Element): boolean =>
  isFundingSection(element) ||
  isFundingFootnote(element) ||
  element.name === "ack";

// A heading holds only its own text, and a part has at most one of each. The
// cutter skips a title, and a label in a part with paragraphs, so an element
// or a second heading would keep text it does not read. A paragraph inside a
// heading would also turn the cutter to the paragraphs, past the bare text
// beside them.
function strayInHeadings(part: Element, path: string): string[] {
  const seen = new Set<string>();
  return part.children
    .filter((child) => child.name !== "p" && PART_CHILDREN.includes(child.name))
    .flatMap((heading) => {
      const headingPath = `${path}/${heading.name}`;
      const repeated = seen.has(heading.name) ? [headingPath] : [];
      seen.add(heading.name);
      return [
        ...repeated,
        ...heading.children.map((child) => `${headingPath}/${child.name}`),
      ];
    });
}

// An id as papers write them: a few letters and a number, such as sp1 or
// d1e123, never a word alone.
const ID = /^[A-Za-z]{0,6}[-_.]?\d+(?:[A-Za-z]{1,3}\d+)*$/u;
const oneOf =
  (...values: string[]) =>
  (value: string) =>
    values.includes(value);

// Each attribute a recording may keep, with the values it may hold: the ones
// the recorded papers carry, and for the types the cutter matches on, the
// values it reads. Any other attribute or value is named. A new recording
// that carries another adds it here, where review sees it.
const ATTRIBUTES = new Map<string, (value: string) => boolean>(
  Object.entries({
    "article-type": oneOf(
      "research-article",
      "review-article",
      "systematic-review",
      "letter",
      "brief-report",
      "case-report",
      "editorial",
    ),
    "dtd-version": (value) => /^\d+(?:\.\d+)*$/u.test(value),
    "xml:lang": (value) => /^[a-z]{2}$/u.test(value),
    "xmlns:xlink": oneOf("http://www.w3.org/1999/xlink"),
    "xmlns:ali": oneOf("http://www.niso.org/schemas/ali/1.0/"),
    "pub-id-type": oneOf("pmcid", "pmid", "pmc", "doi", "publisher-id"),
    "specific-use": oneOf("FundRef", "textmining"),
    "content-type": oneOf("ccbylicense"),
    start_date: (value) => /^\d{4}-\d{2}-\d{2}$/u.test(value),
    "ext-link-type": oneOf("uri", "doi"),
    // A licence or a public domain tool, in a version and maybe a
    // jurisdiction, or its legal code.
    "xlink:href": (value) =>
      /^https?:\/\/creativecommons\.org\/(?:licenses\/[a-z-]+|publicdomain\/(?:zero|mark))\/\d\.\d(?:\/[a-z]{2})?(?:\/legalcode(?:\.[a-z]{2})?)?\/?$/u.test(
        value,
      ),
    "institution-id-type": oneOf("DOI", "FundRef", "ROR", "Ringgold", "ISNI"),
    id: (value) => ID.test(value),
    rid: (value) => value.split(/\s+/u).every((id) => ID.test(id)),
    // As the cutter reads them, taken from src/europepmc/jats.ts (#417).
    "sec-type": (value) => FUNDING_SECTION_TYPE.test(value),
    "fn-type": oneOf(...FUNDING_FOOTNOTE_TYPES),
  }),
);

// The element's own attributes that the check does not expect.
function strayAttributes(element: Element, path: string): string[] {
  return [
    ...(element.malformed ? [`${path} (attributes)`] : []),
    ...element.attributes
      .filter(({ name, value }) => !(ATTRIBUTES.get(name)?.(value) ?? false))
      .map(({ name }) => `${path}@${name}`),
  ];
}

// The same for the element and everything inside it, but an element the
// test picks out, at any depth, is named whole.
function strayAttributesWithin(
  element: Element,
  path: string,
  whole: (child: Element) => boolean = () => false,
): string[] {
  return [
    ...strayAttributes(element, path),
    ...element.children.flatMap((child) => {
      const childPath = `${path}/${child.name}`;
      return whole(child)
        ? [childPath]
        : strayAttributesWithin(child, childPath, whole);
    }),
  ];
}

// The cutter drops every <sec-meta> in a part, in any case, wherever it
// stands, so what one inside a paragraph holds is kept without being read.
// It is named whole (#416).
const isSecMeta = (element: Element): boolean =>
  element.name.toLowerCase() === "sec-meta";

function strayInPart(part: Element, path: string): string[] {
  const paragraphs = part.children.some(
    (child) => child.name === "p" && hasText(child),
  );
  return [
    ...strayAttributes(part, path),
    ...((paragraphs && part.text) || hasUnread(part) ? [`${path} (text)`] : []),
    ...part.children.flatMap((child) => {
      const childPath = `${path}/${child.name}`;
      if (!PART_CHILDREN.includes(child.name)) return [childPath];
      // A heading's children are named whole by strayInHeadings.
      return child.name === "p"
        ? strayAttributesWithin(child, childPath, isSecMeta)
        : strayAttributes(child, childPath);
    }),
    ...strayInHeadings(part, path),
  ];
}

// What the cutter reads whole inside a funding group: each funding
// statement, and each funding source and award id in an award group. Any
// element inside one is read with it, but a comment or a processing
// instruction is dropped unread, so one with text is named (#275, #336).
const READ_WHOLE = new Set([
  `${GROUP}/${statement}`,
  `${GROUP}/${award}/${source}`,
  `${GROUP}/${award}/${id}`,
]);

function stray(element: Element, path: string): string[] {
  if (isPart(element)) return strayInPart(element, path);
  // The cutter reads each element below these, but no attribute's value, so
  // their attributes are checked.
  if (READ_WHOLE.has(path) || ALLOWED[path] === undefined)
    return [
      ...(hasUnread(element) ? [`${path} (text)`] : []),
      ...strayAttributesWithin(element, path),
    ];
  const allowed = ALLOWED[path];
  return [
    ...strayAttributes(element, path),
    ...(element.text ? [`${path} (text)`] : []),
    ...element.children.flatMap((child) => {
      const childPath = `${path}/${child.name}`;
      return allowed(child) ? stray(child, childPath) : [childPath];
    }),
  ];
}

// The path of each part of a recorded full text that falls outside what it
// may keep, of its root if that is not an article, and "(text)" for any text
// outside the root.
export function strayParts(xml: string): string[] {
  const document = parse(xml);
  return [
    ...(document.text ? ["(text)"] : []),
    ...document.children.flatMap((root) =>
      root.name === "article" ? stray(root, "article") : [root.name],
    ),
  ];
}
