import { describe, expect, it } from "vitest";
import {
  CONTACT,
  NOTICE,
  footerOf,
  foreignLoads,
  loadsOf,
  textOf,
} from "./page.ts";

const page = new URL("https://grantlink.uk/");

describe("finding what a page loads", () => {
  it("finds scripts, styles, images and CSS urls", () => {
    const html = `
      <link rel="stylesheet" href="/style.css">
      <script src="https://cdn.example.com/a.js"></script>
      <img srcset="/a.png 1x, https://img.example.com/b.png 2x" src="/a.png">
      <style>body { background: url('https://fonts.example.com/x.woff2'); }</style>
      <style>@import "https://fonts.example.com/css";</style>`;
    expect(loadsOf(html)).toEqual([
      "/style.css",
      "https://cdn.example.com/a.js",
      "/a.png",
      "https://img.example.com/b.png",
      "/a.png",
      "https://fonts.example.com/x.woff2",
      "https://fonts.example.com/css",
    ]);
  });

  it("finds a load whose attribute value is not quoted", () => {
    const html = `<img src=https://img.example.com/c.png alt=x>
      <link rel=stylesheet href=//fonts.example.com/css>`;
    expect(loadsOf(html)).toEqual([
      "https://img.example.com/c.png",
      "//fonts.example.com/css",
    ]);
  });

  it("leaves out links a reader follows", () => {
    expect(loadsOf(`<a href="https://europepmc.org/">Europe PMC</a>`)).toEqual(
      [],
    );
  });

  it("keeps only what reaches another host", () => {
    const html = `<link href="/style.css" rel="stylesheet">
      <link href="https://grantlink.uk/icon.svg" rel="icon">
      <script src="//cdn.example.com/a.js"></script>
      <img src="data:image/png;base64,AAAA">`;
    expect(foreignLoads(html, page)).toEqual(["//cdn.example.com/a.js"]);
  });

  it("counts a load it cannot read as one from another host", () => {
    expect(foreignLoads(`<img src="http://[bad/x.png">`, page)).toEqual([
      "http://[bad/x.png",
    ]);
  });
});

describe("reading a page's words", () => {
  it("drops tags, scripts and styles, and folds whitespace", () => {
    expect(
      textOf("<p>One\n  <b>two</b></p><style>p{}</style><script>x</script>"),
    ).toBe("One two");
  });
});

// The notice belongs in the footer (independence.md). Since #588 the same
// words also sit under the headline, so the live check reads the footer
// alone (#590).
describe("reading a page's footer", () => {
  const notice =
    "grantlink is an independent demonstration on public data from Europe PMC. It is not affiliated with or endorsed by Cancer Research UK.";

  it("finds the notice in the footer", () => {
    const html = `<main><h1>grantlink</h1></main><footer class="x"><p>${notice}</p></footer>`;
    expect(textOf(footerOf(html))).toMatch(NOTICE);
  });

  it("misses the notice when only the line under the headline has it", () => {
    const html = `<main><h1>grantlink</h1><p>${notice}</p></main><footer><p>Data from Europe PMC.</p></footer>`;
    expect(textOf(html)).toMatch(NOTICE);
    expect(textOf(footerOf(html))).not.toMatch(NOTICE);
  });

  it("finds nothing on a page with no footer", () => {
    expect(footerOf(`<main><p>${notice}</p></main>`)).toBe("");
  });

  it("skips a footer that is commented out or inside a script", () => {
    const html = `<!-- <footer><p>${notice}</p></footer> -->
      <script>const f = "<footer>${notice}</footer>";</script>
      <footer><p>Data from Europe PMC.</p></footer>`;
    expect(textOf(footerOf(html))).not.toMatch(NOTICE);
  });

  it("skips an element whose name only starts with footer", () => {
    const html = `<footer-note><p>${notice}</p></footer-note><footer><p>Data from Europe PMC.</p></footer>`;
    expect(textOf(footerOf(html))).not.toMatch(NOTICE);
  });

  // The checks read the correction address from the footer alone (#593).
  it("leaves out an address that sits outside the footer", () => {
    const html = `<p><a href="mailto:${CONTACT}">Write</a></p><footer>Notice</footer>`;
    expect(footerOf(html)).not.toContain(`mailto:${CONTACT}`);
  });

  it("reads the page's footer after an article's own footer", () => {
    const html = `<main><article><p>Paper</p><footer>Card</footer></article></main><footer><a href="mailto:${CONTACT}">Write</a></footer>`;
    expect(footerOf(html)).toContain(`mailto:${CONTACT}`);
  });

  it("reads a footer tag in capitals", () => {
    const html = `<FOOTER><a href="mailto:${CONTACT}">Write</a></FOOTER>`;
    expect(footerOf(html)).toContain(`mailto:${CONTACT}`);
  });
});
