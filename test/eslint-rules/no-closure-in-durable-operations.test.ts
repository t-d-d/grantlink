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
      {
        name: "writes an outer variable in askEuropePmc's step name, which the body evaluates",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        async function run(ctx: any) {
            let page = 0;
            await askEuropePmc(ctx, \`search-\${String(page++)}\`, "wait", r, async () => readPaper());
          }`,
      },
    ],
    invalid: [
      {
        name: "counts into an outer variable from the read of askEuropePmc imported under another name",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc as ask } from "./owed.ts";
        async function run(ctx: any) {
          let read = 0;
          await ask(ctx, "paper", "wait", r, async () => {
            read += 1;
            return readPaper();
          });
        }`,
        errors: [{ messageId: "closureVariableUsage" }],
      },
      {
        name: "counts into an outer variable from askEuropePmc's read",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        async function run(ctx: any) {
          let read = 0;
          await askEuropePmc(ctx, "paper", "wait", r, async () => {
            read += 1;
            return readPaper();
          });
        }`,
        errors: [{ messageId: "closureVariableUsage" }],
      },
      {
        name: "counts into an outer variable from askEuropePmc's retry, which runs inside its step",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        async function run(ctx: any) {
          let tries = 0;
          await askEuropePmc(ctx, "paper", "wait", () => { tries += 1; return r; }, async () => readPaper());
        }`,
        errors: [{ messageId: "closureVariableUsage" }],
      },
      {
        name: "counts into an outer variable from logOnly's log, which runs as its step",
        filename: "src/run/run.ts",
        code: `import { logOnly } from "./log-only.ts";
        async function run(ctx: any) {
          let lines = 0;
          await logOnly(ctx, "search-ended", () => {
            lines += 1;
          });
        }`,
        errors: [{ messageId: "closureVariableUsage" }],
      },
      {
        name: "collects into an outer array from a map item",
        code: `async function run(ctx: any) {
          const found: string[] = [];
          await ctx.map("papers", ids, async (child: any, id: string) => {
            found.push(id);
          });
        }`,
        errors: [{ messageId: "closureVariableUsage" }],
      },
      {
        name: "counts into an outer variable from a parallel branch",
        code: `async function run(ctx: any) {
          let done = 0;
          await ctx.parallel("both", [async () => { done += 1; }]);
        }`,
        errors: [{ messageId: "closureVariableUsage" }],
      },
      {
        name: "counts into an outer variable",
        code: `async function run(ctx: any) {
            let count = 0;
            await ctx.step("count", async () => { count++; });
          }`,
        errors: [{ messageId: "closureVariableUsage" }],
      },
      {
        name: "pushes onto an outer array",
        code: `async function run(ctx: any) {
            const found: number[] = [];
            await ctx.step("find", async () => { found.push(1); });
          }`,
        errors: [{ messageId: "closureVariableUsage" }],
      },
      {
        name: "destructures into an outer variable",
        code: `async function run(ctx: any) {
            let count = 0;
            await ctx.step("count", async () => { [count] = [1]; });
          }`,
        errors: [{ messageId: "closureVariableUsage" }],
      },
      {
        name: "deletes a field of an outer object",
        code: `async function run(ctx: any) {
            const totals: Record<string, number> = { papers: 0 };
            await ctx.step("reset", async () => { delete totals.papers; });
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
