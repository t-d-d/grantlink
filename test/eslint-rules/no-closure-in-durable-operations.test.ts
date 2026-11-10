import { afterAll, describe, it } from "vitest";
import { noClosureInDurableOperations } from "../../eslint-rules/no-closure-in-durable-operations.ts";
import { ruleTester } from "../rule-tester.ts";
import { WRAPPED_DURABLE_CALLS } from "./wrapped-durable-calls.ts";
import { WRAPPED_STEP_HELPERS } from "./wrapped-step-helpers.ts";

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
      {
        name: "counts into an outer variable from a function of owed.ts that is no step helper, asserted with as",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        async function run(ctx: any) {
            let read = 0;
            await (owed.notAHelper as typeof owed.askEuropePmc)(ctx, "paper", "wait", r, async () => {
              read += 1;
              return readPaper();
            });
          }`,
      },
    ],
    invalid: [
      ...WRAPPED_DURABLE_CALLS.map((shape) => ({
        name: `counts into an outer variable inside a step written as ${shape.name}`,
        code: `async function run(ctx: any) {
          let read = 0;
          await ${shape.call("step", `"fetch", async () => { read += 1; return 1; }`)};
        }`,
        errors: [{ messageId: "closureVariableUsage" as const }],
      })),
      ...WRAPPED_STEP_HELPERS.map((shape) => ({
        name: `counts into an outer variable from askEuropePmc's read, reached through ${shape.name}`,
        filename: "src/run/run.ts",
        code: `${shape.prelude}
        async function run(ctx: any) {
          let read = 0;
          await ${shape.callee}(ctx, "paper", "wait", r, async () => {
            read += 1;
            return readPaper();
          });
        }`,
        errors: [{ messageId: "closureVariableUsage" as const }],
      })),
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
        name: "counts into an outer variable from askEuropePmc's read, reached through a namespace import",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        async function run(ctx: any) {
          let read = 0;
          await owed.askEuropePmc(ctx, "paper", "wait", r, async () => {
            read += 1;
            return readPaper();
          });
        }`,
        errors: [{ messageId: "closureVariableUsage" }],
      },
      {
        name: "counts into an outer variable from askEuropePmc's retry, reached through a namespace import",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        async function run(ctx: any) {
          let tries = 0;
          await owed.askEuropePmc(ctx, "paper", "wait", () => { tries += 1; return r; }, async () => readPaper());
        }`,
        errors: [{ messageId: "closureVariableUsage" }],
      },
      {
        name: "counts into an outer variable from askEuropePmc's read, reached through a destructured alias",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        const { askEuropePmc: ask } = owed;
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
        name: "counts into an outer variable from askEuropePmc's retry, reached through a constant read from a namespace import",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        async function run(ctx: any) {
          const ask = owed.askEuropePmc;
          let tries = 0;
          await ask(ctx, "paper", "wait", () => { tries += 1; return r; }, async () => readPaper());
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
