import { describe, expect, it } from "vitest";
import { CONTACT, footerOf, foreignLoads, loadsOf, textOf } from "./page.ts";

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

// The checks read the correction address from the footer alone (#593).
describe("reading a page's footer", () => {
  it("returns the footer's markup", () => {
    const html = `<main>x</main><footer class="f"><a href="mailto:${CONTACT}">Write</a></footer>`;
    expect(footerOf(html)).toContain(`mailto:${CONTACT}`);
  });

  it("leaves out an address that sits outside the footer", () => {
    const html = `<p><a href="mailto:${CONTACT}">Write</a></p><footer>Notice</footer>`;
    expect(footerOf(html)).not.toContain(`mailto:${CONTACT}`);
  });

  it("returns nothing for a page without a footer", () => {
    expect(footerOf(`<a href="mailto:${CONTACT}">Write</a>`)).toBe("");
  });

  it("reads the page's footer after an article's own footer", () => {
    const html = `<main><article><p>Paper</p><footer>Card</footer></article></main><footer><a href="mailto:${CONTACT}">Write</a></footer>`;
    expect(footerOf(html)).toContain(`mailto:${CONTACT}`);
  });

  it("ignores a footer that is commented out", () => {
    const html = `<!-- <footer><a href="mailto:${CONTACT}">Write</a></footer> --><footer>Notice</footer>`;
    expect(footerOf(html)).not.toContain(`mailto:${CONTACT}`);
  });

  it("leaves out an address in an element whose name only starts with footer", () => {
    const html = `<footer-note><a href="mailto:${CONTACT}">Write</a></footer-note><footer>Notice</footer>`;
    expect(footerOf(html)).not.toContain(`mailto:${CONTACT}`);
  });

  it("reads a footer tag in capitals", () => {
    const html = `<FOOTER><a href="mailto:${CONTACT}">Write</a></FOOTER>`;
    expect(footerOf(html)).toContain(`mailto:${CONTACT}`);
  });
});
