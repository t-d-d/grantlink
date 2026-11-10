import { describe, expect, it } from "vitest";
import { plainTitle } from "./europepmc/client.ts";
import { paired, titleParts } from "./title.ts";

// src/title.ts is the one module that pairs a title's tags (#639).
// plainTitle pairs what Europe PMC sends before a title is stored, and the
// page pairs what it reads back, both through paired.
describe("src/title.ts pairs a title's tags for plainTitle and the page", () => {
  it("splits a stored title into its tags and its text", () => {
    expect(titleParts("H<sub>2</sub>O and <I>x</I>")).toEqual([
      { text: "H" },
      { tag: "<sub>" },
      { text: "2" },
      { tag: "</sub>" },
      { text: "O and " },
      { tag: "<i>" },
      { text: "x" },
      { tag: "</i>" },
    ]);
  });

  it("reads a tag with attributes, or any other tag, as text", () => {
    expect(titleParts('<sup class="a">1 <a>b</a>')).toEqual([
      { text: '<sup class="a">1 <a>b</a>' },
    ]);
  });

  it("drops a tag left open, a stray close, and a close that crosses an open tag", () => {
    expect(paired(titleParts("One <i>two"))).toEqual([
      { text: "One " },
      { text: "two" },
    ]);
    expect(paired(titleParts("a</sup> b"))).toEqual([
      { text: "a" },
      { text: " b" },
    ]);
    expect(paired(titleParts("<i>a <b>b</i> c</b>"))).toEqual([
      { text: "a " },
      { tag: "<b>" },
      { text: "b" },
      { text: " c" },
      { tag: "</b>" },
    ]);
  });

  it("leaves what plainTitle keeps as it is", () => {
    for (const raw of [
      "One <i>two",
      "</i> One <b> two",
      "<i>a <b>b</i> c</b>",
      "[&lt;sup&gt;18&lt;/sup&gt;F] <i>in <sub>vivo</sub></i>",
    ]) {
      const parts = titleParts(plainTitle(raw));
      expect(paired(parts)).toEqual(parts);
    }
  });
});
