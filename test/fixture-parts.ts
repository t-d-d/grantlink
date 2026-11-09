// What a full text recorded from a paper may keep (#140,
// docs/constraints/personal-data.md). The cut keeps the paper's ids, its
// licence, its funding metadata, its acknowledgements and its funding
// sections and footnotes. Anything else, such as the author list, the
// affiliations, the title, the abstract, the reference list or the body, can
// carry real names, and is named here.

interface Element {
  name: string;
  open: string;
  children: Element[];
  text: boolean;
}

// The footnote types jats.ts reads as funding text.
const FUNDING_FOOTNOTE =
  /\bfn-type="(?:financial-disclosure|funding|supported-by)"/u;
const FUNDING_SECTION = /\bsec-type="funding"/u;

const isFundingSection = (element: Element): boolean =>
  element.name === "sec" && FUNDING_SECTION.test(element.open);
const isFundingFootnote = (element: Element): boolean =>
  element.name === "fn" && FUNDING_FOOTNOTE.test(element.open);

// For each element whose children are checked, which children it may hold.
// The children of an element allowed here, but not listed, are not checked.
const ALLOWED: Record<string, (child: Element) => boolean> = {
  article: (child) => ["front", "body", "back"].includes(child.name),
  "article/front": (child) => child.name === "article-meta",
  "article/front/article-meta": (child) =>
    ["article-id", "permissions", "funding-group"].includes(child.name),
  "article/body": isFundingSection,
  "article/back": (child) =>
    child.name === "ack" ||
    child.name === "fn-group" ||
    isFundingSection(child) ||
    isFundingFootnote(child),
  "article/back/fn-group": isFundingFootnote,
};

// The XML's elements as a tree, under a root with no name. Declarations,
// processing instructions and comments are dropped, and CDATA counts as
// text.
function parse(xml: string): Element {
  const root: Element = { name: "", open: "", children: [], text: false };
  const stack = [root];
  const tokens =
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[?!][^>]*>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>|[^<]+/gu;
  for (const match of xml.matchAll(tokens)) {
    const [whole, close, name, attributes = "", empty] = match;
    const parent = stack.at(-1) ?? root;
    if (name === undefined) {
      if (whole.startsWith("<![CDATA[") || !whole.startsWith("<")) {
        const text = whole.replace(/^<!\[CDATA\[|\]\]>$/gu, "");
        if (text.trim() !== "") parent.text = true;
      }
    } else if (close === "/") {
      stack.pop();
    } else {
      const element = { name, open: attributes, children: [], text: false };
      parent.children.push(element);
      if (empty !== "/") stack.push(element);
    }
  }
  return root;
}

function stray(element: Element, path: string): string[] {
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
// may keep, or of its root if that is not an article.
export function strayParts(xml: string): string[] {
  return parse(xml).children.flatMap((root) =>
    root.name === "article" ? stray(root, "article") : [root.name],
  );
}
