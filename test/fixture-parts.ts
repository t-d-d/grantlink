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

import {
  FUNDING_FOOTNOTE,
  FUNDING_METADATA,
  isFundingSectionAt,
} from "../src/europepmc/jats.ts";

interface Element {
  name: string;
  children: Element[];
  text: boolean;
  // Whether it holds a comment or a processing instruction with text, which
  // the cutter drops unread.
  unread: boolean;
  // Whether the cutter reads the element as a funding section or footnote.
  funding: boolean;
}

const FOOTNOTE = new RegExp(FUNDING_FOOTNOTE, "u");

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

// The XML's elements as a tree, under a root with no name. Declarations are
// dropped. A processing instruction ends at its own ?>, as in the pattern
// that finds a funding section, so a > inside it does not end it. CDATA and
// comments count as text, since a comment can hold a cut part kept by
// mistake. So does what a processing instruction holds after its target,
// other than the XML declaration's before the root, and what one holds that
// never ends with ?> (#303).
function parse(xml: string): Element {
  const root: Element = {
    name: "",
    children: [],
    text: false,
    unread: false,
    funding: false,
  };
  const stack = [root];
  const tokens =
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[?!][^>]*>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>|[^<]+/gu;
  for (const match of xml.matchAll(tokens)) {
    const [whole, close, name, attributes = "", empty] = match;
    const parent = stack.at(-1) ?? root;
    if (name === undefined) {
      const instruction = /^<\?([^\s?>]*)([\s\S]*?)\??>$/u.exec(whole);
      if (instruction !== null) {
        const [, target = "", data = ""] = instruction;
        const declaration =
          target.toLowerCase() === "xml" &&
          parent === root &&
          root.children.length === 0;
        if (!declaration && data.trim() !== "") {
          parent.text = true;
          parent.unread = true;
        }
      } else if (/^(?:<!\[CDATA\[|<!--|[^<])/u.test(whole)) {
        const text = whole.replace(/^(?:<!\[CDATA\[|<!--)|(?:\]\]|--)>$/gu, "");
        if (text.trim() !== "") {
          parent.text = true;
          if (whole.startsWith("<!--")) parent.unread = true;
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
        children: [],
        text: false,
        unread: false,
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

function strayInPart(part: Element, path: string): string[] {
  const paragraphs = part.children.some(
    (child) => child.name === "p" && hasText(child),
  );
  return [
    ...((paragraphs && part.text) || hasUnread(part) ? [`${path} (text)`] : []),
    ...part.children
      .filter((child) => !PART_CHILDREN.includes(child.name))
      .map((child) => `${path}/${child.name}`),
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
  if (READ_WHOLE.has(path)) return hasUnread(element) ? [`${path} (text)`] : [];
  const allowed = ALLOWED[path];
  if (allowed === undefined)
    return hasUnread(element) ? [`${path} (text)`] : [];
  return [
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
