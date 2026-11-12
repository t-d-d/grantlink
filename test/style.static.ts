import { describe, expect, it } from "vitest";
import { readRepoFile } from "./repo.ts";

const css = readRepoFile("site/style.css");

// The declarations of every rule whose selector list names the selector.
function declarationsFor(selector: string): string[] {
  return [
    ...css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{([^{}]*)\}/gu),
  ]
    .filter(([, selectors]) =>
      (selectors ?? "").split(",").some((one) => one.trim() === selector),
    )
    .map(([, , body]) => (body ?? "").replace(/\s+/gu, " ").trim());
}

// How it's run gives the eval snapshot's 64-character SHA-256 in a
// <code class="ref"> inside a sentence. With no place to break, it pushed
// the page sideways on a phone (#736).
describe("a long reference in a sentence", () => {
  it("may break anywhere, so the page does not scroll sideways on a phone (#736)", () => {
    expect(declarationsFor("code.ref").join(" ")).toMatch(
      /overflow-wrap: anywhere;/u,
    );
  });
});
