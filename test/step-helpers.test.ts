import { describe, expect, it } from "vitest";
import { callbackMismatches } from "./step-helpers.ts";

// The check behind the step helpers' fitness function, on modules held in
// memory: it finds the exported function and compares its function-typed
// parameters after the context with the positions the table lists (#411).
const helper = `
type Ctx = { step: () => void };
type Log = () => void;
export async function help(
  ctx: Ctx,
  step: string,
  retry: (attempt: number) => boolean,
  log: Log,
): Promise<void> {}
`;

describe("callbackMismatches", () => {
  it("passes when the positions are the function-typed parameters", () => {
    expect(callbackMismatches(helper, "help", [2, 3])).toEqual([]);
  });

  it("reports a missing export", () => {
    expect(callbackMismatches(helper, "other", [2, 3])).toEqual([
      "other is not an exported function",
    ]);
  });

  it("reports a function that is not exported", () => {
    const source = helper.replace("export async", "async");
    expect(callbackMismatches(source, "help", [2, 3])).toEqual([
      "help is not an exported function",
    ]);
  });

  it("reports a listed position that is not a function-typed parameter", () => {
    expect(callbackMismatches(helper, "help", [0, 2, 3])).toEqual([
      "help's parameter 0 (ctx) is not a function",
    ]);
  });

  it("reports a listed position past the last parameter", () => {
    expect(callbackMismatches(helper, "help", [2, 3, 4])).toEqual([
      "help has no parameter 4",
    ]);
  });

  it("reports a function-typed parameter after the context that is not listed", () => {
    expect(callbackMismatches(helper, "help", [3])).toEqual([
      "help's parameter 2 (retry) is a function the table does not list",
    ]);
  });

  it("reports both kinds when a parameter is added before the callbacks", () => {
    const source = helper.replace(
      "step: string,",
      "step: string,\n  wait: string,",
    );
    expect(callbackMismatches(source, "help", [2, 3])).toEqual([
      "help's parameter 2 (wait) is not a function",
      "help's parameter 4 (log) is a function the table does not list",
    ]);
  });

  it("finds an exported const arrow function", () => {
    const source = `export const help = (ctx: unknown, log: () => void) => log;`;
    expect(callbackMismatches(source, "help", [1])).toEqual([]);
  });
});
