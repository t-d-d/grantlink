import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../test/repo.ts";

// The page writes a reference or a model id as <code class="ref">. The ref()
// helper is the one place that spells out that markup, so a new place that
// names one calls it rather than copying it (#739, #741).
describe("the page's reference markup", () => {
  it("is written in one place in src/page/render.ts", () => {
    const source = readRepoFile("src/page/render.ts");
    expect(source.match(/<code class="ref">/gu)).toHaveLength(1);
  });
});
