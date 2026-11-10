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
      {
        name: "counts into an outer variable from a function of owed.ts that is no step helper, after askEuropePmc in the comma operator",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        async function run(ctx: any) {
            let read = 0;
            await (owed.askEuropePmc, owed.notAHelper)(ctx, "paper", "wait", r, async () => {
              read += 1;
              return readPaper();
            });
          }`,
      },
    ],
    invalid: [
      ...[
        [
          "asserted with as",
          "(async () => { read += 1; return readPaper(); }) as any",
        ],
        [
          "behind a non-null assertion",
          "(async () => { read += 1; return readPaper(); })!",
        ],
      ].map(([what, callback]) => ({
        name: `counts into an outer variable from askEuropePmc's read ${String(what)}`,
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        async function run(ctx: any) {
          let read = 0;
          await askEuropePmc(ctx, "paper", "wait", r, ${String(callback)});
        }`,
        errors: [{ messageId: "closureVariableUsage" as const }],
      })),

      ...[
        ["pushes through a non-null assertion", "found!.push(1);", "found"],
        [
          "pushes through a type assertion",
          "(found as number[]).push(1);",
          "found",
        ],
        [
          "pushes through satisfies",
          "(found satisfies number[]).push(1);",
          "found",
        ],
        [
          "counts into an outer object through a non-null assertion",
          "totals!.papers += 1;",
          "totals",
        ],
        [
          "assigns an outer variable through a non-null assertion",
          "count! = 1;",
          "count",
        ],
        [
          "deletes from an outer object through a type assertion",
          "delete (totals as any).papers;",
          "totals",
        ],
      ].map(([what, write, name]) => ({
        name: `${String(what)} inside a step`,
        code: `async function run(ctx: any, found: number[], totals: any) {
          let count: number | undefined;
          await ctx.step("count", async () => {
            ${String(write)}
          }, { retryStrategy: r });
        }`,
        errors: [
          { messageId: "closureVariableUsage" as const, data: { name } },
        ],
      })),
      ...[
        ["asserted with as", "(async () => { read += 1; }) as any"],
        ["checked with satisfies", "(async () => { read += 1; }) satisfies F"],
        ["behind a non-null assertion", "(async () => { read += 1; })!"],
      ].map(([what, callback]) => ({
        name: `counts into an outer variable from a step's callback ${String(what)}`,
        code: `async function run(ctx: any) {
          let read = 0;
          await ctx.step("count", ${String(callback)}, { retryStrategy: r });
        }`,
        errors: [{ messageId: "closureVariableUsage" as const }],
      })),

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
      ...[
        [
          "an array of branches asserted with as",
          "[async () => { done += 1; }] as F[]",
        ],
        [
          "an object of branches checked with satisfies",
          "{ one: async () => { done += 1; } } satisfies B",
        ],
        [
          "an array of branches behind a non-null assertion",
          "[async () => { done += 1; }]!",
        ],
      ].map(([what, branches]) => ({
        name: `counts into an outer variable from a parallel branch in ${String(what)}`,
        code: `async function run(ctx: any) {
          let done = 0;
          await ctx.parallel("both", ${String(branches)});
        }`,
        errors: [{ messageId: "closureVariableUsage" as const }],
      })),
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
