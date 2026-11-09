import { afterAll, describe, it } from "vitest";
import { noNestedDurableOperations } from "../../eslint-rules/no-nested-durable-operations.ts";
import { ruleTester } from "../rule-tester.ts";

const tester = ruleTester({ afterAll, describe, it });

describe("fitness: no durable operation inside its own context's operation (durable-execution.md)", () => {
  tester.run("no-nested-durable-operations", noNestedDurableOperations, {
    valid: [
      {
        name: "nests through a child context",
        code: `async function run(ctx: any) {
          await ctx.runInChildContext("paper", async (child: any) => {
            await child.step("fetch", async () => 1);
          });
        }`,
      },
    ],
    invalid: [
      {
        name: "calls a step on the same context inside a step",
        code: `async function run(ctx: any) {
          await ctx.step("outer", async () => {
            await ctx.step("inner", async () => 1);
          });
        }`,
        errors: [{ messageId: "sameContextUsage" }],
      },
      {
        name: "reaches the same context through an alias",
        code: `async function run(ctx: any) {
          const same = ctx;
          await ctx.runInChildContext("paper", async () => {
            await same.wait("pause", { seconds: 1 });
          });
        }`,
        errors: [{ messageId: "sameContextUsage" }],
      },
    ],
  });
});
