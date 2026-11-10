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
// (#215). Two differences stay, where the check is stricter than the
// cutter. The cutter finds a funding section nested in another section,
// but the check refuses the outer section, whose other parts can carry
// names: a recording keeps only the funding section, moved up into the body
// or the back. And in a part with no paragraphs the cutter reads the whole
// text, but the check names any element there other than a label, a title
// or an empty paragraph.
//
// The cutter reads no attribute values but the ids and types it matches on,
// so a value can keep a name nobody reads. On every element a recording
// keeps, the check names each attribute it does not expect, or whose value
// it does not expect (#304). It names the attribute, never its value.

import { FUNDING_FOOTNOTE, isFundingSectionAt } from "../src/europepmc/jats.ts";

interface Attribute {
  name: string;
  value: string;
}

interface Element {
  name: string;
  attributes: Attribute[];
  // Whether its opening tag holds text that is not an attribute.
  malformed: boolean;
  children: Element[];
  text: boolean;
  // Whether it holds a comment with text, which the cutter drops unread.
  comment: boolean;
  // Whether the cutter reads the element as a funding section or footnote.
  funding: boolean;
}

const FOOTNOTE = new RegExp(FUNDING_FOOTNOTE, "u");

const isFundingSection = (element: Element): boolean =>
  element.name === "sec" && element.funding;
const isFundingFootnote = (element: Element): boolean =>
  element.name === "fn" && element.funding;

// For each element whose children are checked, which children it may hold.
// The children of an element allowed here, but not listed, are not checked.
const ALLOWED: Record<string, (child: Element) => boolean> = {
  article: (child) => ["front", "body", "back"].includes(child.name),
  "article/front": (child) => child.name === "article-meta",
  "article/front/article-meta": (child) =>
    ["article-id", "permissions", "funding-group"].includes(child.name),
  "article/front/article-meta/permissions": (child) => child.name === "license",
  "article/body": isFundingSection,
  "article/back": (child) =>
    child.name === "ack" ||
    child.name === "fn-group" ||
    isFundingSection(child) ||
    isFundingFootnote(child),
  "article/back/fn-group": isFundingFootnote,
};

// The attributes in an opening tag, after its name, and whether anything
// else is there.
function attributesOf(tag: string): {
  attributes: Attribute[];
  malformed: boolean;
} {
  const attribute = /\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/uy;
  const attributes: Attribute[] = [];
  // A sticky pattern goes back to the start when it fails, so the end of
  // the last attribute is kept apart.
  let end = 0;
  for (let match = attribute.exec(tag); match; match = attribute.exec(tag)) {
    const [, name = "", double, single] = match;
    attributes.push({ name, value: double ?? single ?? "" });
    end = attribute.lastIndex;
  }
  return { attributes, malformed: tag.slice(end).trim() !== "" };
}

// The XML's elements as a tree, under a root with no name. Declarations and
// processing instructions are dropped. A processing instruction ends at its
// own ?>, as in the pattern that finds a funding section, so a > inside it
// does not end it. CDATA and comments count as text, since a comment can
// hold a cut part kept by mistake.
function parse(xml: string): Element {
  const root: Element = {
    name: "",
    attributes: [],
    malformed: false,
    children: [],
    text: false,
    comment: false,
    funding: false,
  };
  const stack = [root];
  const tokens =
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[?!][^>]*>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>|[^<]+/gu;
  for (const match of xml.matchAll(tokens)) {
    const [whole, close, name, attributes = "", empty] = match;
    const parent = stack.at(-1) ?? root;
    if (name === undefined) {
      if (/^(?:<!\[CDATA\[|<!--|[^<])/u.test(whole)) {
        const text = whole.replace(/^(?:<!\[CDATA\[|<!--)|(?:\]\]|--)>$/gu, "");
        if (text.trim() !== "") {
          parent.text = true;
          if (whole.startsWith("<!--")) parent.comment = true;
        }
      }
    } else if (close === "/") {
      stack.pop();
    } else {
      const funding =
        (name === "sec" && isFundingSectionAt(xml, match.index)) ||
        (name === "fn" && FOOTNOTE.test(attributes));
      const element = {
        name,
        ...attributesOf(attributes),
        children: [],
        text: false,
        comment: false,
        funding,
      };
      parent.children.push(element);
      if (empty !== "/") stack.push(element);
    }
  }
  return root;
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
// (#229).
const PART_CHILDREN = ["p", "title", "label"];

const hasText = (element: Element): boolean =>
  element.text || element.children.some(hasText);

// A comment with text anywhere in a part is named, even in a part with no
// paragraphs, whose other text the cutter reads: the cutter drops comments,
// so what one holds is kept without being read (#230).
const hasComment = (element: Element): boolean =>
  element.comment || element.children.some(hasComment);

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
const ATTRIBUTES: Record<string, (value: string) => boolean> = {
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
  "xlink:href": (value) =>
    /^https?:\/\/creativecommons\.org\/[\w./-]*$/u.test(value),
  "institution-id-type": oneOf("DOI", "FundRef", "ROR", "Ringgold", "ISNI"),
  "name-style": oneOf("western", "eastern", "given-only", "islensk"),
  id: (value) => ID.test(value),
  rid: (value) => value.split(/\s+/u).every((id) => ID.test(id)),
  // As the cutter reads them, in src/europepmc/jats.ts.
  "sec-type": (value) => /^(?:funding|ack|acknowledge?ments?)$/iu.test(value),
  "fn-type": oneOf("financial-disclosure", "funding", "supported-by"),
};

// The element's own attributes that the check does not expect.
function strayAttributes(element: Element, path: string): string[] {
  return [
    ...(element.malformed ? [`${path} (attributes)`] : []),
    ...element.attributes
      .filter(({ name, value }) => !(ATTRIBUTES[name]?.(value) ?? false))
      .map(({ name }) => `${path}@${name}`),
  ];
}

// The same for the element and everything inside it.
function strayAttributesWithin(element: Element, path: string): string[] {
  return [
    ...strayAttributes(element, path),
    ...element.children.flatMap((child) =>
      strayAttributesWithin(child, `${path}/${child.name}`),
    ),
  ];
}

function strayInPart(part: Element, path: string): string[] {
  const paragraphs = part.children.some(
    (child) => child.name === "p" && hasText(child),
  );
  return [
    ...strayAttributes(part, path),
    ...((paragraphs && part.text) || hasComment(part)
      ? [`${path} (text)`]
      : []),
    ...part.children.flatMap((child) => {
      const childPath = `${path}/${child.name}`;
      if (!PART_CHILDREN.includes(child.name)) return [childPath];
      // A heading's children are named whole by strayInHeadings.
      return child.name === "p"
        ? strayAttributesWithin(child, childPath)
        : strayAttributes(child, childPath);
    }),
    ...strayInHeadings(part, path),
  ];
}

function stray(element: Element, path: string): string[] {
  if (isPart(element)) return strayInPart(element, path);
  const allowed = ALLOWED[path];
  // The children of an element whose children are not checked are kept, so
  // their attributes are checked.
  if (allowed === undefined) return strayAttributesWithin(element, path);
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
