import { afterAll, describe, expect, it } from "vitest";
import { noNonDeterministicOutsideStep } from "../../eslint-rules/no-non-deterministic-outside-step.ts";
import { ruleTester } from "../rule-tester.ts";

const tester = ruleTester({ afterAll, describe, it });

describe("fitness: no clock or random read outside a step (durable-execution.md)", () => {
  tester.run(
    "no-non-deterministic-outside-step",
    noNonDeterministicOutsideStep,
    {
      valid: [
        {
          name: "uses Date without reading the clock: instanceof, UTC, parse, prototype and types",
          code: `function f(x: unknown, d: Date): Array<Date> {
            const D = Date;
            const a = x instanceof Date;
            const b = x instanceof D;
            const c = Date.UTC(2020, 0, 1);
            const e = Date.parse("2020-01-01");
            const g = Date.prototype;
            const h = x instanceof (globalThis.Date as DateConstructor);
            const day: Date = new Date(0);
            return [day, d];
          }`,
        },
        {
          name: "tests Date without calling it: typeof and equality",
          code: `function f(x: any) {
            const a = typeof Date === "function";
            const b = x.constructor === Date;
            const c = Date !== x;
            return [a, b, c];
          }`,
        },
        {
          name: "calls a member of Date destructured from a nested pattern that reads no clock",
          code: `async function run(ctx: any) { const { Date: { UTC } } = globalThis; const t = UTC(2020, 0, 1); }`,
        },
        {
          name: "destructures from Date a member that does not call it, given as a nested pattern's default",
          code: `async function run(ctx: any) { const { foo: { UTC: u } = Date } = globalThis; u(2020, 0); }`,
        },
        {
          name: "destructures the name of Date.now, which a step reads",
          code: `async function run(ctx: any) { await ctx.step("n", async () => { const { now: { name } } = Date; return name; }, { retryStrategy: r }); }`,
        },
        {
          name: "passes Date as a value inside a step",
          code: `async function run(ctx: any) {
            await ctx.step("at", async () => ids.map(Date), { retryStrategy: r });
          }`,
        },
        {
          name: "reads the clock inside a step's callback through the comma operator",
          code: `async function run(ctx: any) {
            await ctx.step("start", (0, async () => Date.now()), { retryStrategy: r });
          }`,
        },
        {
          name: "reads the clock inside askEuropePmc's read through the comma operator",
          filename: "src/run/run.ts",
          code: `import { askEuropePmc } from "./owed.ts";
          async function run(ctx: any) {
            await askEuropePmc(ctx, "paper", "wait", r, (0, async () => Date.now()));
          }`,
        },
        {
          name: "reads the clock inside a step's callback asserted with as",
          code: `async function run(ctx: any) {
            await ctx.step("start", (async () => Date.now()) as any, { retryStrategy: r });
          }`,
        },

        {
          name: "reads the clock inside a step",
          code: `async function run(ctx: any) {
            const startedAt = await ctx.step("start", async () => new Date().toISOString());
            const id = await ctx.step("id", async () => crypto.randomUUID());
          }`,
        },
        {
          name: "reads the clock inside askEuropePmc's read, which runs as its step",
          filename: "src/run/run.ts",
          code: `import { askEuropePmc } from "./owed.ts";
          async function run(ctx: any) {
            await askEuropePmc(ctx, "paper", "wait", r, async () => Date.now());
          }`,
        },
        {
          name: "reads the clock inside logOnly's log, which runs as its step",
          filename: "src/run/run.ts",
          code: `import { logOnly } from "./log-only.ts";
          async function run(ctx: any) {
            await logOnly(ctx, "search-ended", () => {
              logAt(Date.now());
            });
          }`,
        },
        {
          name: "reads the clock through a string key inside a step",
          code: `async function run(ctx: any) {
            await ctx.step("start", async () => Date["now"](), { retryStrategy: r });
          }`,
        },
        {
          name: "reads the clock through an alias inside a step",
          code: `const D = Date;
          async function run(ctx: any) {
            await ctx.step("start", async () => D.now(), { retryStrategy: r });
          }`,
        },
        {
          name: "reads the clock through globalThis inside a step",
          code: `async function run(ctx: any) {
            await ctx.step("start", async () => globalThis.Date.now(), { retryStrategy: r });
          }`,
        },
        {
          name: "reads the clock through global inside a step",
          code: `async function run(ctx: any) {
            await ctx.step("start", async () => global.Date.now(), { retryStrategy: r });
          }`,
        },
        {
          name: "reads now through a parameter that shadows global",
          code: `async function run(ctx: any, global: { Date: { now(): number } }) { const now = global.Date.now(); }`,
        },
        {
          name: "draws a named import of randomUUID inside a step",
          code: `import { randomUUID } from "node:crypto";
          async function run(ctx: any) {
            await ctx.step("id", async () => randomUUID(), { retryStrategy: r });
          }`,
        },
        {
          name: "calls a local function named like a random source",
          code: `function randomUUID() { return "fixed"; }
          async function run(ctx: any) {
            const id = randomUUID();
          }`,
        },
        {
          name: "reads now from a local object that shadows Date",
          code: `async function run(ctx: any, Date: { now(): number }) {
            const now = Date.now();
          }`,
        },
        {
          name: "draws a named import from a module that is not crypto",
          code: `import { randomUUID } from "./ids.ts";
          async function run(ctx: any) {
            const id = randomUUID();
          }`,
        },
        {
          name: "names a random source's type with typeof",
          code: `import { randomUUID } from "node:crypto";
          type MakeId = typeof randomUUID;
          let make: typeof randomUUID | undefined;`,
        },
        {
          name: "exports a random source's type only",
          code: `import { randomUUID } from "node:crypto";
          export type { randomUUID };
          export { type randomUUID as MakeId };`,
        },
        {
          name: "re-exports another module's name that a local random source shares",
          code: `import { randomUUID } from "node:crypto";
          export { randomUUID } from "./fixed";`,
        },
        {
          name: "exports an object that holds no clock or random source",
          code: `const J = JSON;
          export { J };
          export const { parse } = JSON;
          export * from "./fixed";
          export * from "node:path";`,
        },
        {
          name: "exports by default an object that holds no clock or random source",
          code: `export default JSON;`,
        },
        {
          name: "passes on the types of a module that holds a random source",
          code: `export type * from "node:crypto";
          import type * as c from "node:crypto";
          export type { c };`,
        },
        {
          name: "reads a wrapped clock and random source inside a step",
          code: `async function run(ctx: any) {
            const at = await ctx.step("at", async () => (Date as any).now());
            const day = await ctx.step("day", async () => new (Date as any)());
            const id = await ctx.step("id", async () => crypto!.randomUUID());
          }`,
        },
        {
          name: "parses a fixed date",
          code: `const since = new Date("2020-01-01");`,
        },
        {
          name: "reads the clock as a string inside a step",
          code: `async function run(ctx: any) {
            const at = await ctx.step("at", async () => Date());
          }`,
        },
        {
          name: "calls and constructs a local Date that shadows the global",
          code: `async function run(ctx: any) {
            const Date = () => "fixed";
            const a = Date();
            const b = new (Date as any)();
          }`,
        },
        {
          name: "calls a Date parameter that shadows the global",
          code: `function stamp(Date: () => string) { return Date(); }`,
        },
        {
          name: "calls random on a parameter that shadows Math",
          code: `function f(Math: Rng) { return Math.random(); }`,
        },
        {
          name: "calls now on, and constructs, a local that shadows Date",
          code: `class Date { static now() { return 0; } }
          const at = Date.now();
          const today = new Date();`,
        },
        {
          name: "reads a wrapped parameter that shadows Date",
          code: `function f(Date: Clock) {
            return [(Date as any).now(), new Date!()];
          }`,
        },
        {
          name: "draws from a local that shadows crypto",
          code: `const crypto = fixedSource();
          const id = crypto.randomUUID();`,
        },
        {
          name: "reads a member of Math under a constant key outside a step",
          filename: "src/run/run.ts",
          code: `const M = Math;
          const a = Math.floor(x);
          const b = M.max(1, 2);
          const c = typeof crypto === "undefined";
          const d = globalThis.Math.abs(-1);`,
        },
        {
          name: "passes Math on and draws random from it inside a step",
          filename: "src/run/run.ts",
          code: `async function run(ctx: any) {
            await ctx.step("pick", async () => helper(Math), { retryStrategy: r });
            await ctx.step("draw", async () => Math.random(), { retryStrategy: r });
          }`,
        },
        {
          name: "tests an object that holds a source, or Date, without passing it on",
          filename: "src/run/run.ts",
          code: `const a = "randomUUID" in globalThis.crypto;
          const b = "now" in Date;
          if (globalThis.crypto) { x(); }
          const c = !crypto;
          const d = performance ? 1 : 2;
          const e = Date && f();`,
        },
      ],
      invalid: [
        {
          name: "passes on the rest of a namespace import of crypto, or an object that holds a source as a fallback",
          filename: "src/run/run.ts",
          code: `import * as c from "node:crypto";
          const { createHash, ...rest } = c;
          const p = globalThis.performance ?? fallback;`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "crypto" },
              line: 2,
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "performance" },
              line: 3,
            },
          ],
        },
        {
          name: "copies the rest of Math given as the default of a nested pattern",
          filename: "src/run/run.ts",
          code: `const { Math: { ...rest } = Math } = globalThis;`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math" },
              line: 1,
            },
          ],
        },
        {
          name: "passes an object that holds a source on in an exported object",
          filename: "src/run/o.ts",
          code: `export const o = { m: Math };`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math" },
              line: 1,
            },
          ],
        },
        {
          name: "passes Math to a helper, which may call random on it",
          filename: "src/run/run.ts",
          code: `function helper(m: Math) { return m.random(); }
          const n = helper(Math);`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math" },
              line: 2,
            },
          ],
        },
        {
          name: "returns crypto from a function",
          filename: "src/run/run.ts",
          code: `function source() { return crypto; }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "crypto" },
              line: 1,
            },
          ],
        },
        {
          name: "passes on an object that holds a source through an alias, globalThis or a key it cannot name",
          filename: "src/run/run.ts",
          code: `const M = Math;
          const a = helper(M);
          const b = [globalThis.crypto];
          const c = helper(globalThis);
          const d = Math[k];
          const e = { ...performance };`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math" },
              line: 2,
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "crypto" },
              line: 3,
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "globalThis" },
              line: 4,
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math" },
              line: 5,
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "performance" },
              line: 6,
            },
          ],
        },
        {
          name: "passes on a namespace import of crypto",
          filename: "src/run/run.ts",
          code: `import * as c from "node:crypto";
          const a = helper(c);`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "crypto" },
              line: 2,
            },
          ],
        },
        {
          name: "passes Date as a value for something else to call",
          code: `const a = ids.map(Date);
          const b = Reflect.construct(Date, []);
          const c = Date.call(null);
          const d = Date.apply(null, []);
          const e = Date["bind"](null);
          const f = ids.map(globalThis.Date);
          const g = ids.map(Date as any);
          const h = { make: Date };`,
          errors: Array.from({ length: 8 }, (_, i) => ({
            messageId: "nonDeterministicOutsideStep" as const,
            data: { op: "Date" },
            line: i + 1,
          })),
        },
        {
          name: "reads a member of Date under a key it cannot name, which may be call",
          code: `function f(k: string) {
            return Date[k](null);
          }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date" },
              line: 2,
            },
          ],
        },
        {
          name: "re-exports a random source, which another module may call",
          code: `import { randomUUID } from "node:crypto";
          export { randomUUID };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "crypto.randomUUID" },
              line: 2,
            },
          ],
        },
        {
          name: "re-exports a random source from the module that holds it",
          code: `export { randomUUID } from "node:crypto";`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "crypto.randomUUID" },
              line: 1,
            },
          ],
        },
        {
          name: "exports a destructured clock in its declaration and again by name, once",
          code: `export const { now } = Date;
          export { now as clock };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Date.now" },
              line: 1,
            },
          ],
        },
        {
          name: "exports a clock destructured from Date in its declaration",
          code: `export const { now } = Date;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Date.now" },
              line: 1,
            },
          ],
        },
        {
          name: "exports a random source destructured from Math by name",
          code: `const { random } = Math;
          export { random };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Math.random" },
              line: 2,
            },
          ],
        },
        {
          name: "exports Date destructured from globalThis under another name",
          code: `export const { Date: D } = globalThis;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Date" },
              line: 1,
            },
          ],
        },
        {
          name: "exports a destructured clock with a default, renamed in the export",
          code: `const { now: clock = () => 0 } = performance;
          export { clock as now };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "performance.now" },
              line: 2,
            },
          ],
        },
        {
          name: "exports by name an alias of Math, which another module may call random on",
          code: `const M = Math;
          export { M };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Math" },
              line: 2,
            },
          ],
        },
        {
          name: "exports an alias of Math in its declaration and again by name, once",
          code: `export const M = Math;
          export { M as N };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Math" },
              line: 1,
            },
          ],
        },
        {
          name: "exports an alias of Math in its declaration",
          code: `export const M = Math;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Math" },
              line: 1,
            },
          ],
        },
        {
          name: "exports webcrypto destructured from a nested pattern under another name",
          code: `export const { crypto: { webcrypto: w } } = globalThis;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "crypto" },
              line: 1,
            },
          ],
        },
        {
          name: "exports Math destructured from globalThis under another name",
          code: `export const { Math: M } = globalThis;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Math" },
              line: 1,
            },
          ],
        },
        {
          name: "exports a copy of globalThis made through a rest",
          code: `export const { ...g } = globalThis;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "globalThis" },
              line: 1,
            },
          ],
        },
        {
          name: "exports a copy of Math made through a rest",
          code: `export const { ...m } = Math;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Math" },
              line: 1,
            },
          ],
        },
        {
          name: "exports a copy of Math made through a rest by name",
          code: `const { ...m } = Math;
          export { m };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Math" },
              line: 1,
            },
          ],
        },
        {
          name: "exports a copy of Math made through a rest in a nested pattern's default",
          code: `export const { foo: { ...m } = Math } = {};`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Math" },
              line: 1,
            },
          ],
        },
        {
          name: "exports bind destructured from Date",
          code: `export const { bind } = Date;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Date" },
              line: 1,
            },
          ],
        },
        {
          name: "exports an alias of globalThis, which holds every source",
          code: `const g = globalThis;
          export { g };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "globalThis" },
              line: 2,
            },
          ],
        },
        {
          name: "exports a namespace import of crypto",
          code: `import * as c from "node:crypto";
          export { c as random };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "crypto" },
              line: 2,
            },
          ],
        },
        {
          name: "exports performance imported from perf_hooks",
          code: `import { performance } from "node:perf_hooks";
          export { performance };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "performance" },
              line: 2,
            },
          ],
        },
        {
          name: "re-exports every name from crypto",
          code: `export * from "node:crypto";`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "crypto" },
              line: 1,
            },
          ],
        },
        {
          name: "re-exports crypto as a namespace",
          code: `export * as c from "crypto";`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "crypto" },
              line: 1,
            },
          ],
        },
        {
          name: "re-exports every name from perf_hooks",
          code: `export * from "node:perf_hooks";`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "perf_hooks" },
              line: 1,
            },
          ],
        },
        {
          name: "re-exports webcrypto from the module that holds it",
          code: `export { webcrypto } from "node:crypto";`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "crypto" },
              line: 1,
            },
          ],
        },
        {
          name: "re-exports the default of crypto, which is the module itself",
          code: `export { default as c } from "node:crypto";`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "crypto" },
              line: 1,
            },
          ],
        },
        {
          name: "exports crypto imported by the name default",
          code: `import { default as c } from "node:crypto";
          export { c };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "crypto" },
              line: 2,
            },
          ],
        },
        {
          name: "exports Math by default",
          code: `export default Math;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Math" },
              line: 1,
            },
          ],
        },
        {
          name: "exports by default an alias of Math and a namespace import of crypto",
          code: `const M = globalThis.Math;
          export default M;
          import * as c from "node:crypto";
          export = c;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Math" },
              line: 2,
            },
            {
              messageId: "exportedOutsideStep",
              data: { op: "crypto" },
              line: 4,
            },
          ],
        },
        {
          name: "exports an alias of Math in its declaration and again by default, once",
          code: `export const M = Math;
          export default M;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Math" },
              line: 1,
            },
          ],
        },
        {
          name: "exports an alias of Date, which another module may call",
          code: `export const D = Date;
          const E = Date;
          export { E };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Date" },
              line: 1,
            },
            {
              messageId: "exportedOutsideStep",
              data: { op: "Date" },
              line: 2,
            },
          ],
        },
        {
          name: "exports an alias of the clock, in its declaration and by name, as an export",
          code: `export const now = Date.now;
          const clock = performance.now;
          export { clock };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Date.now" },
              line: 1,
            },
            {
              messageId: "exportedOutsideStep",
              data: { op: "performance.now" },
              line: 2,
            },
          ],
        },
        {
          name: "reports an alias of Math passed on by name at the export",
          code: `const M = Math;
          export { M };`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Math" },
              line: 2,
            },
          ],
        },
        {
          name: "reports a call to the clock at the read",
          code: `const at = Date.now();`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
              line: 1,
            },
          ],
        },
        {
          name: "reports a clock read whose value is exported at the read, since the value and not the clock passes on",
          code: `export const d = new Date();
          export const t = Date();`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "new Date()" },
              line: 1,
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date()" },
              line: 2,
            },
          ],
        },
        {
          name: "reports the clock exported by default as an export",
          code: `export default Date.now;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Date.now" },
              line: 1,
            },
          ],
        },
        {
          name: "reports the clock exported by assignment as an export",
          code: `export = Date.now;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Date.now" },
              line: 1,
            },
          ],
        },
        {
          name: "reports Date exported by default as an export",
          code: `export default Date;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Date" },
              line: 1,
            },
          ],
        },
        {
          name: "reports an alias of Date exported by default as an export",
          code: `const D = Date;
          export default D;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Date" },
              line: 2,
            },
          ],
        },
        {
          name: "reports an alias of the clock exported by default at its read and at the export",
          code: `const now = Date.now;
          export default now;`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now" },
              line: 1,
            },
            {
              messageId: "exportedOutsideStep",
              data: { op: "Date.now" },
              line: 2,
            },
          ],
        },
        {
          name: "passes Date as a value through an alias, at the use and not the alias",
          code: `const D = Date;
          async function run(ctx: any) {
            const at = ids.map(D);
          }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date" },
              line: 3,
            },
          ],
        },
        {
          name: "reads the clock in the read of a local function that shares askEuropePmc's name",
          filename: "src/run/run.ts",
          code: `function askEuropePmc(...args: unknown[]) { return args; }
          async function run(ctx: any) {
            await askEuropePmc(ctx, "paper", "wait", r, async () => Date.now());
          }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock in the body",
          code: `async function run(ctx: any) {
            const now = Date.now();
            const today = new Date();
          }`,
          errors: [
            { messageId: "nonDeterministicOutsideStep" },
            { messageId: "nonDeterministicOutsideStep" },
          ],
        },
        {
          name: "reads the clock in an array's map, which is not a step",
          code: `async function run(ctx: any, papers: string[]) {
            const stamped = papers.map(() => Date.now());
          }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads random in a durable map, which replays its callbacks",
          code: `async function run(ctx: any, ids: string[]) {
            await ctx.map("papers", ids, async (child: any) => Math.random());
          }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock in a step's name, which the body evaluates",
          code: "async function run(ctx: any) { await ctx.step(`at-${Date.now()}`, async () => 1); }",
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock in askEuropePmc's step name, which the body evaluates",
          filename: "src/run/run.ts",
          code: 'import { askEuropePmc } from "./owed.ts"; async function run(ctx: any) { await askEuropePmc(ctx, `at-${Date.now()}`, "wait", r, async () => 1); }',
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock ahead of a step's callback in the comma operator, which the body evaluates, and inside the callback, which the step runs",
          code: `async function run(ctx: any) {
            await ctx.step("s", (Date.now(), async () => Date.now()), { retryStrategy: r });
          }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
            },
          ],
        },
        {
          name: "reads the clock ahead of askEuropePmc's read in the comma operator, which the body evaluates, and inside the read, which the step runs",
          filename: "src/run/run.ts",
          code: `import { askEuropePmc } from "./owed.ts";
          async function run(ctx: any) {
            await askEuropePmc(ctx, "paper", "wait", r, (Date.now(), async () => Date.now()));
          }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
            },
          ],
        },
        {
          name: "draws a random integer",
          code: `const n = crypto.randomInt(5);`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock through as, satisfies and a non-null assertion on Date",
          code: `async function run(ctx: any) {
            const a = (Date as any).now();
            const b = (Date satisfies DateConstructor).now();
            const c = Date!.now();
          }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
            },
          ],
        },
        {
          name: "reads random through as, satisfies and a non-null assertion on Math",
          code: `async function run(ctx: any) {
            const a = (Math as any).random();
            const b = (Math satisfies Math).random();
            const c = Math!.random();
          }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math.random()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math.random()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math.random()" },
            },
          ],
        },
        {
          name: "reads random through as, satisfies and a non-null assertion on crypto",
          code: `async function run(ctx: any) {
            const a = (crypto as any).randomUUID();
            const b = (crypto satisfies Crypto).randomUUID();
            const c = crypto!.randomUUID();
          }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "crypto.randomUUID()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "crypto.randomUUID()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "crypto.randomUUID()" },
            },
          ],
        },
        {
          name: "constructs the current date through as, satisfies and a non-null assertion on Date",
          code: `async function run(ctx: any) {
            const a = new (Date as any)();
            const b = new (Date satisfies DateConstructor)();
            const c = new Date!();
          }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "new Date()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "new Date()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "new Date()" },
            },
          ],
        },
        {
          name: "reads the clock as a string by calling Date without new",
          code: `async function run(ctx: any) {
            const a = Date();
            const b = (Date as any)();
            const c = Date!();
          }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date()" },
            },
          ],
        },
        {
          name: "reads the clock past a type named Date, which shadows no value",
          code: `type Date = string;
          async function run(ctx: any) {
            const a = Date();
            const b = new Date();
          }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "new Date()" },
            },
          ],
        },
        {
          name: "passes a random source by reference",
          code: `const pick = items.sort(Math.random);`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math.random" },
            },
          ],
        },
        {
          name: "calls the clock plainly, which reports a call",
          code: `const at = Date.now();`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
            },
          ],
        },
        {
          name: "calls the clock through a non-null assertion, a type assertion and the comma operator",
          code: `const a = Date.now!();
          const b = (Date.now as any)();
          const c = (<any>Math.random)();
          const d = (0, crypto.randomUUID)();
          const e = Date.now?.();`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math.random()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "crypto.randomUUID()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
            },
          ],
        },
        {
          name: "draws from crypto imported from node:crypto",
          code: `import crypto from "node:crypto";
          const a = crypto.randomBytes(8);`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "crypto.randomBytes()" },
            },
          ],
        },
        {
          name: "draws from crypto imported whole from crypto",
          code: `import * as crypto from "crypto";
          const a = crypto.randomInt(8);`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "crypto.randomInt()" },
            },
          ],
        },
        {
          name: "reads performance imported from node:perf_hooks",
          code: `import { performance } from "node:perf_hooks";
          const t = performance.now();`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "performance.now()" },
            },
          ],
        },
        {
          name: "reads the global beside a type, an interface and an ambient declaration of its name",
          code: `interface Math { extra: number }
          type Date = string;
          declare const crypto: Crypto;
          const n = Math.random();
          const at = Date.now();
          const today = new Date();
          const id = crypto.randomUUID();`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math.random()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "new Date()" },
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "crypto.randomUUID()" },
            },
          ],
        },
        {
          name: "reads the global Math beside a function whose parameter shadows it",
          code: `function f(Math: Rng) { return Math.random(); }
          const n = Math.random();`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math.random()" },
            },
          ],
        },
        {
          name: "reads the clock through a string key",
          code: `async function run(ctx: any) { const now = Date["now"](); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "draws random through a template key",
          code: "async function run(ctx: any) { const n = Math[`random`](); }",
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock through a local alias",
          code: `async function run(ctx: any) { const D = Date; const now = D.now(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock through a chain of aliases",
          code: `const D = Date; const E = D as DateConstructor; async function run(ctx: any) { const now = E.now(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock through an alias of the method, at the alias and at the call",
          code: `const now = Date.now;
          async function run(ctx: any) {
            const at = now();
          }`,
          errors: [
            { messageId: "nonDeterministicOutsideStep" },
            { messageId: "nonDeterministicOutsideStep" },
          ],
        },
        {
          name: "reads the clock destructured from Date",
          code: `async function run(ctx: any) { const { now } = Date; const at = now(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock through globalThis",
          code: `async function run(ctx: any) { const now = globalThis.Date.now(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "draws random through globalThis with a string key",
          code: `async function run(ctx: any) { const n = globalThis["Math"].random(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "makes a date through globalThis",
          code: `async function run(ctx: any) { const today = new globalThis.Date(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock through global",
          code: `async function run(ctx: any) { const now = global.Date.now(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "draws random through global with a string key",
          code: `async function run(ctx: any) { const n = global["Math"].random(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "makes a date through global",
          code: `async function run(ctx: any) { const today = new global.Date(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock through an alias of global",
          code: `const g = global; async function run(ctx: any) { const now = g.Date.now(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "makes a date through an alias",
          code: `const D = Date; async function run(ctx: any) { const today = new D(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock through an alias of globalThis",
          code: `const g = globalThis; async function run(ctx: any) { const now = g.Date.now(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "draws a named import of randomUUID",
          code: `import { randomUUID } from "node:crypto"; async function run(ctx: any) { const id = randomUUID(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "draws a renamed import of randomBytes",
          code: `import { randomBytes as bytes } from "crypto"; async function run(ctx: any) { const b = bytes(8); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "draws from a default import of crypto",
          code: `import nodeCrypto from "node:crypto"; async function run(ctx: any) { const id = nodeCrypto.randomUUID(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "draws from a namespace import of crypto",
          code: `import * as c from "node:crypto"; async function run(ctx: any) { const id = c["randomUUID"](); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads a named import of performance",
          code: `import { performance as perf } from "node:perf_hooks"; async function run(ctx: any) { const t = perf.now(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads performance from a namespace import of perf_hooks",
          code: `import * as hooks from "perf_hooks"; async function run(ctx: any) { const t = hooks.performance.now(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock from an ambient declaration of performance",
          code: `declare const performance: { now(): number }; async function run(ctx: any) { const t = performance.now(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "draws random from a global declared in declare global",
          code: `declare global { var crypto: { randomUUID(): string } } async function run(ctx: any) { const id = crypto.randomUUID(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads the clock destructured from a nested pattern",
          code: `async function run(ctx: any) { const { Date: { now } } = globalThis; now(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
            },
          ],
        },
        {
          name: "draws random destructured from a nested pattern with a default",
          code: `async function run(ctx: any) { const { Math: { random: r } = Math } = globalThis; const n = r(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math.random()" },
            },
          ],
        },
        {
          name: "draws random from Math given as the default of a destructured name",
          code: `async function run(ctx: any) { const { foo: M = Math } = globalThis; M.random(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math.random()" },
            },
          ],
        },
        {
          name: "draws random destructured from Math given as the default of a nested pattern",
          code: `async function run(ctx: any) { const { foo: { random: r } = Math } = globalThis; r(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math.random()" },
            },
          ],
        },
        {
          name: "calls Date given as the default of a destructured name, once at the call",
          code: `async function run(ctx: any) { const { foo: D = Date } = x; D(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date()" },
              column: 61,
            },
          ],
        },
        {
          name: "passes Date on as a nested default that destructures a member calling it",
          code: `async function run(ctx: any) { const { foo: { bind: b } = Date } = x; const f = b(null); }`,
          errors: [
            { messageId: "nonDeterministicOutsideStep", data: { op: "Date" } },
          ],
        },
        {
          name: "exports Date given as the default of a destructured name, once at the name",
          code: `export const { foo: D = Date } = x;`,
          errors: [
            {
              messageId: "exportedOutsideStep",
              data: { op: "Date" },
              column: 21,
            },
          ],
        },
        {
          name: "passes Date on as a default the rule does not follow, of a parameter",
          code: `async function run(ctx: any) { const f = ({ foo: D = Date }: any) => D; }`,
          errors: [
            { messageId: "nonDeterministicOutsideStep", data: { op: "Date" } },
          ],
        },
        {
          name: "draws random from Math given as the default when the initial value starts at another holder",
          code: `async function run(ctx: any) { const { foo: M = Math } = Date; M.random(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math.random()" },
            },
          ],
        },
        {
          name: "draws random destructured from Math given as a nested default when the initial value starts at another holder",
          code: `async function run(ctx: any) { const { foo: { random: r } = Math } = Date; r(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math.random()" },
            },
          ],
        },
        {
          name: "passes Date on as a default when the name follows Math from its initial value",
          code: `async function run(ctx: any) { const { Math: M = Date } = globalThis; }`,
          errors: [
            { messageId: "nonDeterministicOutsideStep", data: { op: "Date" } },
          ],
        },
        {
          name: "reads the clock destructured from Date with a default",
          code: `async function run(ctx: any) { const { now = () => 0 } = Date; const at = now(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "draws random from a named import of webcrypto",
          code: `import { webcrypto } from "node:crypto"; async function run(ctx: any) { const b = webcrypto.getRandomValues(new Uint8Array(4)); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
        {
          name: "reads Date.now in a pattern that destructures call from it",
          code: `async function run(ctx: any) { const { now: { call: c } } = Date; c(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now" },
              column: 40,
            },
          ],
        },
        {
          name: "reads Date.now in a nested pattern that destructures bind from it",
          code: `async function run(ctx: any) { const { Date: { now: { bind: b } } } = globalThis; b(null)(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now" },
              column: 48,
            },
          ],
        },
        {
          name: "destructures bind from Date and calls what it returns",
          code: `async function run(ctx: any) { const { bind: b } = Date; b(null)(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date" },
              column: 52,
            },
          ],
        },
        {
          name: "destructures bind from Date in a nested pattern",
          code: `async function run(ctx: any) { const { Date: { bind: b } } = globalThis; b(null)(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date" },
              column: 40,
            },
          ],
        },
        {
          name: "destructures call from Date given as a nested pattern's default",
          code: `async function run(ctx: any) { const { foo: { call: c } = Date } = globalThis; c(null); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date" },
              column: 59,
            },
          ],
        },
        {
          name: "draws random from Math given as a nested pattern's default",
          code: `async function run(ctx: any) { const { foo: { random: r } = Math } = globalThis; r(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Math.random()" },
              column: 82,
            },
          ],
        },
        {
          name: "reads the clock from Date given as a default deeper in a pattern",
          code: `async function run(ctx: any) { const { a: { b: { now } = Date } } = globalThis; now(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
              column: 81,
            },
          ],
        },
        {
          name: "gives Date as a parameter's default to a pattern the rule does not follow",
          code: `async function run(ctx: any) { const stamp = ({ now } = Date) => now(); stamp(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date" },
              column: 57,
            },
          ],
        },
        {
          name: "gives Date as a parameter's default to a nested pattern that reads now from it",
          code: `async function run(ctx: any) { const stamp = ({ now: { call } } = Date) => call(); stamp(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date" },
              column: 67,
            },
          ],
        },
        {
          name: "gives Date as a nested default in an assignment the rule does not follow, from globalThis, which it passes on",
          code: `async function run(ctx: any) { let now: any; ({ foo: { now } = Date } = globalThis); now(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date" },
              column: 64,
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "globalThis" },
              column: 73,
            },
          ],
        },
        {
          name: "gives Date as a nested default in a loop's pattern, which has no initial value",
          code: `async function run(ctx: any) { for (const { foo: { now } = Date } of [{}]) now(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date" },
              column: 60,
            },
          ],
        },
        {
          name: "reads the clock from a Date default under a key that names another holder",
          code: `async function run(ctx: any) { const { crypto: { now } = Date } = globalThis; now(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
              column: 79,
            },
          ],
        },
        {
          name: "reads the clock from a Date default in a pattern that destructures a holder",
          code: `async function run(ctx: any) { const { foo: { now } = Date } = Math; now(); }`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date.now()" },
              column: 70,
            },
          ],
        },
        {
          name: "draws random through crypto.webcrypto",
          code: `import * as c from "crypto"; async function run(ctx: any) { const id = c.webcrypto.randomUUID(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
      ],
    },
  );
});

describe("no-non-deterministic-outside-step's messages", () => {
  const { messages } = noNonDeterministicOutsideStep.meta;

  it("tells a read to move inside a step", () => {
    expect(messages.nonDeterministicOutsideStep).toContain(
      "a replay reads a new value. Move it inside `ctx.step(...)`",
    );
    expect(messages.nonDeterministicOutsideStep).toContain(
      "add `// eslint-disable-next-line grantlink/no-non-deterministic-outside-step -- <why it is safe>`",
    );
  });

  it("tells an export that another module may read the source unseen, and how to fix it", () => {
    expect(messages.exportedOutsideStep).toContain(
      "passes to another module, which may read it outside every step where this rule cannot see",
    );
    expect(messages.exportedOutsideStep).toContain(
      "Export a function that takes the value from a step instead",
    );
    expect(messages.exportedOutsideStep).toContain(
      "add `// eslint-disable-next-line grantlink/no-non-deterministic-outside-step -- <why it is safe>`",
    );
    expect(messages.exportedOutsideStep).not.toContain("Move it inside");
  });
});
