import { describe, expect, it } from "vitest";
import { callbackMismatches } from "./step-helpers.ts";

// The check behind the step helpers' fitness function, on modules held in
// memory: it finds the exported function and compares its function-typed
// parameters after the context with the positions the table lists (#411). It sits in the static tier because
// the compiler reads lib files and package types from the repo.
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

  it("reads an overloaded function's implementation", () => {
    const source = [
      "export function help(ctx: unknown): void;",
      "export function help(ctx: unknown, log: () => void): void;",
      "export function help(ctx: unknown, log?: () => void): void {}",
    ].join("\n");
    expect(callbackMismatches(source, "help", [1])).toEqual([]);
  });

  it("counts a parameter that may be a function as one", () => {
    const source = `export function help(ctx: unknown, log: string | (() => void)) {}`;
    expect(callbackMismatches(source, "help", [])).toEqual([
      "help's parameter 1 (log) is a function the table does not list",
    ]);
  });

  it("reports a parameter whose type does not resolve", () => {
    const source = [
      `import type { Log } from "./no-such-module.ts";`,
      "export function help(ctx: unknown, log: Log) {}",
    ].join("\n");
    expect(callbackMismatches(source, "help", [])).toEqual([
      "help's parameter 1 (log) has a type the check cannot read",
    ]);
  });

  it("reports a rest parameter of functions, listed or not", () => {
    const source = `export function help(ctx: unknown, ...fns: Array<() => void>) {}`;
    const problem =
      "help's parameter 1 (fns) is a rest parameter of functions, which the table cannot list";
    expect(callbackMismatches(source, "help", [])).toEqual([problem]);
    expect(callbackMismatches(source, "help", [1])).toEqual([problem]);
  });

  it("reports a rest parameter of functions in the context's place", () => {
    const source = `export function help(...fns: Array<() => void>) {}`;
    expect(callbackMismatches(source, "help", [])).toEqual([
      "help's parameter 0 (fns) is a rest parameter of functions, which the table cannot list",
    ]);
  });

  it("passes a rest parameter that holds no function", () => {
    const source = `export function help(ctx: unknown, ...steps: string[]) {}`;
    expect(callbackMismatches(source, "help", [])).toEqual([]);
  });

  it("reports a rest parameter whose element type does not resolve", () => {
    const source = [
      `import type { Log } from "./no-such-module.ts";`,
      "export function help(ctx: unknown, ...logs: Log[]) {}",
    ].join("\n");
    expect(callbackMismatches(source, "help", [])).toEqual([
      "help's parameter 1 (logs) has a type the check cannot read",
    ]);
  });

  it("reports an array parameter of functions, listed or not", () => {
    const source = `export function help(ctx: unknown, fns: Array<() => void>) {}`;
    const problem =
      "help's parameter 1 (fns) is an array of functions, which the table cannot list";
    expect(callbackMismatches(source, "help", [])).toEqual([problem]);
    expect(callbackMismatches(source, "help", [1])).toEqual([problem]);
  });

  it("reports a readonly array or a tuple that holds a function", () => {
    const source = [
      "export function help(",
      "  ctx: unknown,",
      "  logs: readonly (() => void)[],",
      "  pair: [string, () => void],",
      ") {}",
    ].join("\n");
    expect(callbackMismatches(source, "help", [])).toEqual([
      "help's parameter 1 (logs) is an array of functions, which the table cannot list",
      "help's parameter 2 (pair) is an array of functions, which the table cannot list",
    ]);
  });

  it("reports an array of functions that is one member of a union", () => {
    const source = `export function help(ctx: unknown, fns: string | Array<() => void>) {}`;
    expect(callbackMismatches(source, "help", [])).toEqual([
      "help's parameter 1 (fns) is an array of functions, which the table cannot list",
    ]);
  });

  it("reports a rest parameter of functions held in a tuple", () => {
    const source = `export function help(ctx: unknown, ...fns: [() => void, string]) {}`;
    expect(callbackMismatches(source, "help", [])).toEqual([
      "help's parameter 1 (fns) is a rest parameter of functions, which the table cannot list",
    ]);
  });

  it("passes an array parameter that holds no function", () => {
    const source = `export function help(ctx: unknown, steps: string[], pair: [string, number]) {}`;
    expect(callbackMismatches(source, "help", [])).toEqual([]);
  });

  it("reports a generic array or rest parameter constrained to functions", () => {
    const source = [
      "export function help<T extends Array<() => void>>(",
      "  ctx: unknown,",
      "  fns: T,",
      "  ...more: T",
      ") {}",
    ].join("\n");
    expect(callbackMismatches(source, "help", [])).toEqual([
      "help's parameter 1 (fns) is an array of functions, which the table cannot list",
      "help's parameter 2 (more) is a rest parameter of functions, which the table cannot list",
    ]);
  });

  it("reads a recursive array type without looping", () => {
    const source = [
      "type Json = string | Json[];",
      "type Logs = (() => void) | Logs[];",
      "export function help(ctx: unknown, value: Json, logs: Logs[]) {}",
    ].join("\n");
    expect(callbackMismatches(source, "help", [])).toEqual([
      "help's parameter 2 (logs) is an array of functions, which the table cannot list",
    ]);
  });

  it("reads a callback in a union with an unread array as a callback", () => {
    const source = `export function help(ctx: unknown, log: (() => void) | any[]) {}`;
    expect(callbackMismatches(source, "help", [1])).toEqual([]);
  });

  it("reports an array parameter whose element type does not resolve", () => {
    const source = [
      `import type { Log } from "./no-such-module.ts";`,
      "export function help(ctx: unknown, logs: Log[]) {}",
    ].join("\n");
    expect(callbackMismatches(source, "help", [])).toEqual([
      "help's parameter 1 (logs) has a type the check cannot read",
    ]);
  });
});
