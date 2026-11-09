// What every view of the page must carry, and how to find what a page
// loads. The static tier reads site/, the live tier the deployed page.

// Independent and unbranded (independence.md).
export const NOTICE =
  /independent demonstration on public data from Europe PMC\. It is not affiliated with or endorsed by Cancer Research UK\./u;

// The credit Europe PMC's terms ask for (licence.md).
export const CREDIT = /href="https:\/\/europepmc\.org\/"/u;

// Corrections and removals (PRD #1, "Accurate, and correctable").
export const CONTACT = "thomas.david.dickinson@gmail.com";

// The page's words, without tags or runs of whitespace.
export function textOf(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

// Every URL the page makes the browser fetch by itself: scripts, styles,
// images, fonts, frames and media, in markup or in CSS. A link a reader
// follows by choice, an <a href>, is not a load.
export function loadsOf(text: string): string[] {
  const found: string[] = [];
  const tag = /<(\w+)\b([^>]*)>/gu;
  for (const [, name = "", attributes = ""] of text.matchAll(tag)) {
    const element = name.toLowerCase();
    if (element === "a") continue;
    for (const [, attribute = "", , value = ""] of attributes.matchAll(
      /\b(src|href|srcset|poster|data|action|formaction)\s*=\s*(["'])(.*?)\2/giu,
    )) {
      if (attribute.toLowerCase() === "srcset") {
        found.push(
          ...value.split(",").map((part) => part.trim().split(/\s+/u)[0] ?? ""),
        );
      } else {
        found.push(value);
      }
    }
  }
  for (const [, , url = ""] of text.matchAll(
    /url\(\s*(["']?)(.*?)\1\s*\)/giu,
  )) {
    found.push(url);
  }
  for (const [, , url = ""] of text.matchAll(/@import\s+(["'])(.*?)\1/giu)) {
    found.push(url);
  }
  return found.filter((url) => url !== "");
}

// The loads that reach a host other than the page's own.
export function foreignLoads(text: string, page: URL): string[] {
  return loadsOf(text).filter((url) => {
    if (url.startsWith("data:")) return false;
    return new URL(url, page).host !== page.host;
  });
}
