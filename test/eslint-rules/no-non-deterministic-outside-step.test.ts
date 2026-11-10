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
          name: "parses a fixed date",
          code: `const since = new Date("2020-01-01");`,
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
          name: "draws from a local that shadows crypto",
          code: `const crypto = fixedSource();
          const id = crypto.randomUUID();`,
        },
      ],
      invalid: [
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
          name: "draws a random integer",
          code: `const n = crypto.randomInt(5);`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
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
      ],
    },
  );
});
