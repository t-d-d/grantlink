import { afterAll, describe, it } from "vitest";
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
          name: "re-exports a random source without reading it",
          code: `import { randomUUID } from "node:crypto";
          export { randomUUID };`,
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
      ],
      invalid: [
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
          name: "exports an alias of Date, which another module may call",
          code: `export const D = Date;
          const E = Date;
          export { E };`,
          errors: [
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date" },
              line: 1,
            },
            {
              messageId: "nonDeterministicOutsideStep",
              data: { op: "Date" },
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
          name: "draws random through crypto.webcrypto",
          code: `import * as c from "crypto"; async function run(ctx: any) { const id = c.webcrypto.randomUUID(); }`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
      ],
    },
  );
});
