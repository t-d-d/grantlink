import { afterAll, describe, it } from "vitest";
import { noClosureInDurableOperations } from "../../eslint-rules/no-closure-in-durable-operations.ts";
import { ruleTester } from "../rule-tester.ts";

const tester = ruleTester({ afterAll, describe, it });

describe("fitness: no outer variable changed inside a step (durable-execution.md)", () => {
  tester.run("no-closure-in-durable-operations", noClosureInDurableOperations, {
    valid: [
      {
        name: "returns the value and assigns it outside",
        code: `async function run(ctx: any) {
            let count = 0;
            count = await ctx.step("count", async () => {
              let local = 0;
              local += 1;
              return local;
            });
          }`,
      },
    ],
    invalid: [
      {
        name: "counts into an outer variable",
        code: `async function run(ctx: any) {
            let count = 0;
            await ctx.step("count", async () => { count++; });
          }`,
        errors: [{ messageId: "closureVariableUsage" }],
      },
      {
        name: "writes a field of an outer object",
        code: `async function run(ctx: any) {
            const totals = { papers: 0 };
            await ctx.step("count", async () => { totals.papers += 1; });
          }`,
        errors: [{ messageId: "closureVariableUsage" }],
      },
    ],
  });
});
