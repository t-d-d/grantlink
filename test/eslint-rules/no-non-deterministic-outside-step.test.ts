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
          name: "reads the clock inside a step",
          code: `async function run(ctx: any) {
            const startedAt = await ctx.step("start", async () => new Date().toISOString());
            const id = await ctx.step("id", async () => crypto.randomUUID());
          }`,
        },
        {
          name: "parses a fixed date",
          code: `const since = new Date("2020-01-01");`,
        },
      ],
      invalid: [
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
          name: "draws a random integer",
          code: `const n = crypto.randomInt(5);`,
          errors: [{ messageId: "nonDeterministicOutsideStep" }],
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
