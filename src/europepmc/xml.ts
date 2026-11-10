import { Parser } from "htmlparser2";

// Reads XML into a tree through one parser, for the cutter in jats.ts and the
// check on recorded fixtures in test/fixture-parts.ts (#343). The parser runs
// on Node alone and never fetches a DTD or resolves an entity: a document
// type declaration is dropped unread, and an entity reference stays in the
// text as written until the cutter decodes the few it knows.

export interface XmlAttribute {
  name: string;
  value: string;
}

export interface XmlElement {
  kind: "element";
  name: string;
  // Its attributes in quotes, in the order written.
  attributes: XmlAttribute[];
  // Whether its opening tag holds anything but attributes in quotes, each
  // after white space and each named once, or its closing tag holds anything
  // but white space.
  malformed: boolean;
  // Whether it is self-closing.
  empty: boolean;
  // Where its opening tag starts in the XML, and its closing tag, if it has
  // one of its own.
  start: number;
  close: number | undefined;
  children: XmlNode[];
}

export type XmlNode =
  | XmlElement
  | { kind: "text"; text: string }
  | { kind: "cdata"; text: string }
  | { kind: "comment"; text: string }
  | { kind: "instruction"; target: string; data: string };

const element = (name: string, start: number): XmlElement => ({
  kind: "element",
  name,
  attributes: [],
  malformed: false,
  empty: false,
  start,
  close: undefined,
  children: [],
});

// An opening tag that holds only its name and its attributes in quotes, each
// after white space, as XML has it. The parser reads past a stray / and
// attributes with no white space between them without saying so (#354).
const OPENING_TAG =
  /^<[^\s/>]+(?:\s+[^\s/>"'=]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>$/u;

// The XML's nodes under a root with no name, as the parser reads them. An
// element is closed by the next closing tag of its name that is still open,
// and that tag closes every element opened inside it too. A closing tag
// with no element open of its name is skipped, and every element still open
// at the end is closed there. Such an element has no closing tag of its own.
// Text and CDATA keep their entity references as written. Read in any case,
// every tag's name is written in lower case, so a closing tag closes an
// element whose name differs from its own only in case.
export function parseXml(
  xml: string,
  { anyCase = false }: { anyCase?: boolean } = {},
): XmlElement {
  const root = element("", 0);
  const open: XmlElement[] = [root];
  const top = (): XmlElement => open.at(-1) ?? root;
  let attributes: XmlAttribute[] = [];
  let cdata = false;
  let openStart = -1;
  let openEnd = -1;
  // After a processing instruction, or a closing tag with white space before
  // its >, the parser starts the next tag one place early, at that >, so a
  // tag starts at the first < from there (#386).
  const tagStart = (): number => xml.indexOf("<", parser.startIndex);
  const parser = new Parser(
    {
      onattribute(name, value, quote) {
        // An attribute with no value, or with one not in quotes, is not XML,
        // and the tag's source says so.
        if (quote === '"' || quote === "'") attributes.push({ name, value });
      },
      onopentag(name) {
        const start = tagStart();
        const tag = xml.slice(start, parser.endIndex + 1);
        const names = new Set(attributes.map((found) => found.name));
        const opened = {
          ...element(name, start),
          attributes,
          // An attribute written twice is not XML either.
          malformed: !OPENING_TAG.test(tag) || names.size !== attributes.length,
        };
        top().children.push(opened);
        open.push(opened);
        attributes = [];
        openStart = parser.startIndex;
        openEnd = parser.endIndex;
      },
      onclosetag(_name, implied) {
        const closed = open.pop();
        if (closed === undefined) return;
        if (!implied) {
          closed.close = tagStart();
          // The parser ends a closing tag at its name, and skips anything
          // after the name.
          const end = xml.indexOf(">", parser.endIndex);
          if (xml.slice(parser.endIndex, end).trim() !== "") {
            closed.malformed = true;
          }
        } else if (
          parser.startIndex === openStart &&
          parser.endIndex === openEnd
        ) {
          // A self-closing element closes where it opens.
          closed.empty = true;
        }
      },
      ontext(text) {
        const siblings = top().children;
        const last = siblings.at(-1);
        const kind = cdata ? "cdata" : "text";
        if (last?.kind === kind) last.text += text;
        else siblings.push({ kind, text });
      },
      oncdatastart() {
        cdata = true;
      },
      oncdataend() {
        cdata = false;
      },
      oncomment(text) {
        top().children.push({ kind: "comment", text });
      },
      onprocessinginstruction(name, data) {
        // A declaration, such as the document type, is dropped unread.
        if (!name.startsWith("?")) return;
        const [, target = "", rest = ""] =
          /^([^\s?]*)([\s\S]*)$/u.exec(data.slice(1)) ?? [];
        top().children.push({ kind: "instruction", target, data: rest });
      },
    },
    { xmlMode: true, decodeEntities: false, lowerCaseTags: anyCase },
  );
  parser.end(xml);
  return root;
}

// The XML's nodes as the cutter reads them, in any case (#354), which differ
// from parseXml's otherwise only when tags do not balance (#263). Then which
// closing tag is missing cannot be told, so an element the cutter reads by its
// name, as readByName says, is read with care, and holds no element of its
// name: one never closed, or opened inside one of its name read with care. It
// ends at the next opening or closing tag of its name, whether that is its own
// or not, and one with none after it is dropped, with all it holds, so a broken
// element never takes in the rest of the paper. What it held after the tag that
// ends it follows it in its parent instead, and an element that held that tag
// ends there too. Any other element never closed ends where the parser ends it,
// at its parent's closing tag, and keeps what it holds, so a broken inline
// element or part of the article loses no words. A self-closing element is
// empty, and is neither a boundary nor ends one (#195).
export function readXml(
  xml: string,
  readByName: (name: string) => boolean,
): XmlElement {
  const root = parseXml(xml, { anyCase: true });
  const tags = new Map<string, number[]>();
  const careful = new Set<XmlElement>();
  const mark = (parent: XmlElement, names: ReadonlySet<string>): void => {
    for (const child of parent.children) {
      if (child.kind !== "element") continue;
      if (!child.empty) {
        const at = tags.get(child.name) ?? [];
        at.push(child.start);
        if (child.close !== undefined) at.push(child.close);
        tags.set(child.name, at);
      }
      const isCareful =
        !child.empty &&
        readByName(child.name) &&
        (child.close === undefined || names.has(child.name));
      if (isCareful) careful.add(child);
      mark(child, isCareful ? new Set([...names, child.name]) : names);
    }
  };
  mark(root, new Set());
  // When every tag balances, the tree is read as parsed.
  if (careful.size === 0) return root;
  for (const at of tags.values()) at.sort((a, b) => a - b);

  const rebuild = (nodes: XmlNode[]): XmlNode[] => {
    const queue = [...nodes];
    const kept: XmlNode[] = [];
    for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
      if (node.kind !== "element") {
        kept.push(node);
        continue;
      }
      if (!careful.has(node)) {
        kept.push({ ...node, children: rebuild(node.children) });
        continue;
      }
      const { name, start } = node;
      const next = tags.get(name)?.find((at) => at > start);
      if (next === undefined) continue;
      const [before, after] = cut(node, next);
      kept.push({ ...before, children: rebuild(before.children) });
      queue.unshift(...after);
    }
    return kept;
  };
  return { ...root, children: rebuild(root.children) };
}

// An element cut at the opening tag that starts at this index, if it holds
// one there: itself up to that tag, and what it held from there on.
function cut(node: XmlElement, at: number): [XmlElement, XmlNode[]] {
  const children = node.children;
  for (const [i, child] of children.entries()) {
    if (child.kind !== "element") continue;
    if (child.start === at) {
      return [{ ...node, children: children.slice(0, i) }, children.slice(i)];
    }
    const [before, after] = cut(child, at);
    if (after.length > 0) {
      return [
        { ...node, children: [...children.slice(0, i), before] },
        [...after, ...children.slice(i + 1)],
      ];
    }
  }
  return [node, []];
}

// These nodes under a root with no name.
export const fragment = (children: XmlNode[]): XmlElement => ({
  ...element("", 0),
  children,
});

// Each element below this node, in the order its opening tags come.
export function* descendants(node: XmlElement): Generator<XmlElement> {
  for (const child of node.children) {
    if (child.kind !== "element") continue;
    yield child;
    yield* descendants(child);
  }
}

// The elements below this node that pass the test, but not those inside one
// that passes.
export function outermost(
  node: XmlElement,
  test: (element: XmlElement) => boolean,
): XmlElement[] {
  return node.children.flatMap((child) => {
    if (child.kind !== "element") return [];
    return test(child) ? [child] : outermost(child, test);
  });
}

// The value of the attribute with this name, if the element has one.
export function attribute(
  element: XmlElement,
  name: string,
): string | undefined {
  return element.attributes.find((found) => found.name === name)?.value;
}

// Nodes written back out as XML.
export function serialize(nodes: XmlNode[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
          return node.text;
        case "cdata":
          return `<![CDATA[${node.text}]]>`;
        case "comment":
          return `<!--${node.text}-->`;
        case "instruction":
          return `<?${node.target}${node.data}?>`;
        case "element": {
          // A value holds no quote of the kind it was written in, so one
          // that holds a double quote was in single quotes.
          const attributes = node.attributes
            .map(({ name, value }) =>
              value.includes('"')
                ? ` ${name}='${value}'`
                : ` ${name}="${value}"`,
            )
            .join("");
          return node.empty
            ? `<${node.name}${attributes}/>`
            : `<${node.name}${attributes}>${serialize(node.children)}</${node.name}>`;
        }
      }
    })
    .join("");
}
