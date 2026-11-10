import { afterAll, describe, it } from "vitest";
import { noNestedDurableOperations } from "../../eslint-rules/no-nested-durable-operations.ts";
import { ruleTester } from "../rule-tester.ts";
import { WRAPPED_DURABLE_CALLS } from "./wrapped-durable-calls.ts";
import { WRAPPED_STEP_HELPERS } from "./wrapped-step-helpers.ts";

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
      {
        name: "asks Europe PMC on a child context",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        async function run(ctx: any) {
          await ctx.runInChildContext("paper", async (child: any) => {
            await askEuropePmc(child, "fetch", "wait", r, async () => 1);
          });
        }`,
      },
    ],
    invalid: [
      ...WRAPPED_DURABLE_CALLS.map((shape) => ({
        name: `uses the same context inside a step written as ${shape.name}`,
        code: `async function run(ctx: any) {
          await ${shape.call("step", `"outer", async () => { await ctx.wait("pause", { seconds: 1 }); }`)};
        }`,
        errors: [{ messageId: "sameContextUsage" as const }],
      })),
      ...WRAPPED_STEP_HELPERS.map((shape) => ({
        name: `asks Europe PMC through ${shape.name} on the same context inside a step`,
        filename: "src/run/run.ts",
        code: `${shape.prelude}
        async function run(ctx: any) {
          await ctx.step("outer", async () => {
            await ${shape.callee}(ctx, "paper", "wait", r, async () => 1);
          });
        }`,
        errors: [{ messageId: "sameContextUsage" as const }],
      })),
      ...WRAPPED_STEP_HELPERS.map((shape) => ({
        name: `calls a step on the same context inside askEuropePmc's read, reached through ${shape.name}`,
        filename: "src/run/run.ts",
        code: `${shape.prelude}
        async function run(ctx: any) {
          await ${shape.callee}(ctx, "paper", "wait", r, async () => {
            await ctx.step("inner", async () => 1);
          });
        }`,
        errors: [{ messageId: "sameContextUsage" as const }],
      })),
      {
        name: "asks Europe PMC through a renamed import on the same context inside a step",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc as ask } from "./owed.ts";
        async function run(ctx: any) {
          await ctx.step("outer", async () => {
            await ask(ctx, "paper", "wait", r, async () => 1);
          });
        }`,
        errors: [{ messageId: "sameContextUsage" }],
      },
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
        name: "calls a step on the same context inside askEuropePmc's read",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        async function run(ctx: any) {
          await askEuropePmc(ctx, "paper", "wait", r, async () => {
            await ctx.step("inner", async () => 1);
          });
        }`,
        errors: [{ messageId: "sameContextUsage" }],
      },
      {
        name: "calls a step on the same context inside logOnly's log",
        filename: "src/run/run.ts",
        code: `import { logOnly } from "./log-only.ts";
        async function run(ctx: any) {
          await logOnly(ctx, "search-ended", () => {
            void ctx.step("inner", async () => 1);
          });
        }`,
        errors: [{ messageId: "sameContextUsage" }],
      },
      {
        name: "asks Europe PMC on the same context inside a step",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        async function run(ctx: any) {
          await ctx.step("outer", async () => {
            await askEuropePmc(ctx, "paper", "wait", r, async () => 1);
          });
        }`,
        errors: [{ messageId: "sameContextUsage" }],
      },
      {
        name: "calls a step on the same context inside askEuropePmc's read, reached through a namespace import",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        async function run(ctx: any) {
          await owed.askEuropePmc(ctx, "paper", "wait", r, async () => {
            await ctx.step("inner", async () => 1);
          });
        }`,
        errors: [{ messageId: "sameContextUsage" }],
      },
      {
        name: "asks Europe PMC through a namespace import on the same context inside a step",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        async function run(ctx: any) {
          await ctx.step("outer", async () => {
            await owed.askEuropePmc(ctx, "paper", "wait", r, async () => 1);
          });
        }`,
        errors: [{ messageId: "sameContextUsage" }],
      },
      {
        name: "calls a step on the same context inside askEuropePmc's read, reached through a destructured alias",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        const { askEuropePmc: ask } = owed;
        async function run(ctx: any) {
          await ask(ctx, "paper", "wait", r, async () => {
            await ctx.step("inner", async () => 1);
          });
        }`,
        errors: [{ messageId: "sameContextUsage" }],
      },
      {
        name: "asks Europe PMC through a constant read from a namespace import on the same context inside a step",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        async function run(ctx: any) {
          const ask = owed.askEuropePmc;
          await ctx.step("outer", async () => {
            await ask(ctx, "paper", "wait", r, async () => 1);
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
