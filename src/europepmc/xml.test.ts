import { describe, expect, it } from "vitest";
import { descendants, parseXml } from "./xml.ts";

describe("where parseXml starts an element (#386)", () => {
  it.each([
    ["a processing instruction", "<a><?pi?><b>x</b></a>"],
    ["a closing tag with white space before its >", "<a><c></c ><b>x</b></a>"],
  ])("starts an element at its <, after %s", (_after, xml) => {
    const b = [...descendants(parseXml(xml))].find(
      (found) => found.name === "b",
    );
    expect(b?.start).toBe(xml.indexOf("<b>"));
    expect(b?.empty).toBe(false);
  });

  it.each([
    ["a processing instruction", "<a><?pi?><b/></a>"],
    ["a closing tag with white space before its >", "<a><c></c ><b/></a>"],
  ])("starts a self-closing element at its <, after %s", (_after, xml) => {
    const b = [...descendants(parseXml(xml))].find(
      (found) => found.name === "b",
    );
    expect(b?.start).toBe(xml.indexOf("<b/>"));
    expect(b?.empty).toBe(true);
  });

  it.each([
    ["a processing instruction", "<a><?pi?></a>"],
    ["a closing tag with white space before its >", "<a><c></c ></a>"],
  ])("starts a closing tag at its <, after %s", (_after, xml) => {
    const a = [...descendants(parseXml(xml))].find(
      (found) => found.name === "a",
    );
    expect(a?.close).toBe(xml.indexOf("</a>"));
  });
});
