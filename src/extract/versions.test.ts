import { describe, expect, it } from "vitest";
import { PROMPT_VERSION, PROMPT_VERSIONS } from "./model.ts";
import { RULES_VERSION, RULES_VERSIONS } from "./rules.ts";
import { latest } from "./versions.ts";

// A version names one set of rules or one prompt only if no two branches can
// both bump to it. Each bump adds its own line naming its issue, so two
// bumps at once edit the same place differently and git makes them
// conflict (#414).

describe("a version history", () => {
  it("names its last version", () => {
    expect(
      latest("rules", [
        { number: 10, issue: 368 },
        { number: 11, issue: 414 },
      ]),
    ).toBe("rules-11");
  });

  it("refuses an empty history", () => {
    expect(() => latest("rules", [])).toThrow(/no version/u);
  });

  it("refuses a version that does not follow the one before", () => {
    expect(() =>
      latest("rules", [
        { number: 10, issue: 368 },
        { number: 10, issue: 414 },
      ]),
    ).toThrow(/rules-10 does not follow rules-10/u);
  });

  it("refuses two versions made by one issue", () => {
    expect(() =>
      latest("prompt", [
        { number: 2, issue: 313 },
        { number: 3, issue: 313 },
      ]),
    ).toThrow(/#313 made two versions/u);
  });
});

describe("the versions recorded with every result", () => {
  it("is read from the last line of the rules' history, not set by hand", () => {
    expect(RULES_VERSION).toBe(latest("rules", RULES_VERSIONS));
  });

  it("is read from the last line of the prompt's history, not set by hand", () => {
    expect(PROMPT_VERSION).toBe(latest("prompt", PROMPT_VERSIONS));
  });
});
