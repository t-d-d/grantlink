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

import { FUNDING_FOOTNOTE, isFundingSectionAt } from "../src/europepmc/jats.ts";

interface Element {
  name: string;
  children: Element[];
  text: boolean;
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

// The XML's elements as a tree, under a root with no name. Declarations and
// processing instructions are dropped. CDATA and comments count as text,
// since a comment can hold a cut part kept by mistake.
function parse(xml: string): Element {
  const root: Element = { name: "", children: [], text: false, funding: false };
  const stack = [root];
  const tokens =
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[?!][^>]*>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>|[^<]+/gu;
  for (const match of xml.matchAll(tokens)) {
    const [whole, close, name, attributes = "", empty] = match;
    const parent = stack.at(-1) ?? root;
    if (name === undefined) {
      if (/^(?:<!\[CDATA\[|<!--|[^<])/u.test(whole)) {
        const text = whole.replace(/^(?:<!\[CDATA\[|<!--)|(?:\]\]|--)>$/gu, "");
        if (text.trim() !== "") parent.text = true;
      }
    } else if (close === "/") {
      stack.pop();
    } else {
      const funding =
        (name === "sec" && isFundingSectionAt(xml, match.index)) ||
        (name === "fn" && FOOTNOTE.test(attributes));
      const element = { name, children: [], text: false, funding };
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
    ...(paragraphs && part.text ? [`${path} (text)`] : []),
    ...part.children
      .filter((child) => !PART_CHILDREN.includes(child.name))
      .map((child) => `${path}/${child.name}`),
    ...strayInHeadings(part, path),
  ];
}

function stray(element: Element, path: string): string[] {
  if (isPart(element)) return strayInPart(element, path);
  const allowed = ALLOWED[path];
  if (allowed === undefined) return [];
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
