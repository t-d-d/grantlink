// A title's inline markup: the sup, sub, i and b that Europe PMC uses for
// the 18 of [18F] or the 2 of H2O (#606). This is the one module that names
// those tags and pairs them (#639). plainTitle pairs what Europe PMC sends
// before a title is stored, and the page pairs what it reads back, so a
// title's markup never reaches past the title.

const INLINE = ["sup", "sub", "i", "b"] as const;

export type Part = { tag: string } | { text: string };

// The tag pattern's alternatives, for a pattern that reads Europe PMC's own
// encodings of the same tags.
export const INLINE_NAMES = INLINE.join("|");

// A stored title holds each tag as plainTitle wrote it, with no
// attribute, so only that is read as a tag. Anything else is text.
const STORED = new RegExp(`<(/?)(${INLINE_NAMES})>`, "giu");

export function titleParts(title: string): Part[] {
  const parts: Part[] = [];
  let from = 0;
  for (const match of title.matchAll(STORED)) {
    if (match.index > from)
      parts.push({ text: title.slice(from, match.index) });
    from = match.index + match[0].length;
    parts.push({ tag: `<${match[1] ?? ""}${(match[2] ?? "").toLowerCase()}>` });
  }
  if (from < title.length) parts.push({ text: title.slice(from) });
  return parts;
}

// Drops a tag left without its pair: one still open at the end, a close
// with nothing open, or a close that would cross a tag opened inside it.
export function paired(parts: Part[]): Part[] {
  const open: number[] = [];
  const drop = new Set<number>();
  parts.forEach((part, i) => {
    if (!("tag" in part)) return;
    if (!part.tag.startsWith("</")) open.push(i);
    else {
      const last = parts[open.at(-1) ?? -1];
      if (last && "tag" in last && last.tag === part.tag.replace("/", "")) {
        open.pop();
      } else drop.add(i);
    }
  });
  for (const i of open) drop.add(i);
  return parts.filter((_, i) => !drop.has(i));
}
