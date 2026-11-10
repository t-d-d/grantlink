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
          name: "passes a random source by reference",
          code: `const pick = items.sort(Math.random);`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
        },
      ],
    },
  );
});
