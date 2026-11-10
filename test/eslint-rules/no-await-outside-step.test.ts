import { afterAll, describe, it } from "vitest";
import { noAwaitOutsideStep } from "../../eslint-rules/no-await-outside-step.ts";
import { ruleTester } from "../rule-tester.ts";

const tester = ruleTester({ afterAll, describe, it });

describe("fitness: no bare await in a durable body (durable-execution.md)", () => {
  tester.run("no-await-outside-step", noAwaitOutsideStep, {
    valid: [
      {
        name: "awaits a durable operation",
        code: `async function run(ctx: any) {
          await ctx.step("fetch", async () => 1, { retryStrategy: r });
          await ctx.wait("pause", { seconds: 1 });
          await ctx.map("papers", ids, async (child: any, id: string) => id);
        }`,
      },
      {
        name: "awaits I/O inside a step",
        code: `async function run(ctx: any) {
          await ctx.step("fetch", async () => { return await fetchPaper(); });
        }`,
      },
      {
        name: "awaits askEuropePmc, whose only await is its step",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        async function run(ctx: any) {
          const asked = await askEuropePmc(ctx, "paper", "wait", r, async () => readPaper());
        }`,
      },
      {
        name: "awaits I/O inside askEuropePmc's read, which runs as its step",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        async function run(ctx: any) {
          await askEuropePmc(ctx, "paper", "wait", r, async () => {
            return await readPaper();
          });
        }`,
      },
      {
        name: "awaits askEuropePmc imported under another name",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc as ask } from "./owed.ts";
        async function run(ctx: any) {
          await ask(ctx, "paper", "wait", r, async () => {
            return await readPaper();
          });
        }`,
      },
      {
        name: "awaits askEuropePmc imported from a folder below src/run",
        filename: "src/run/papers/run.ts",
        code: `import { askEuropePmc } from "../owed.ts";
        async function run(ctx: any) {
          await askEuropePmc(ctx, "paper", "wait", r, async () => readPaper());
        }`,
      },
    ],
    invalid: [
      {
        name: "awaits I/O in the body",
        code: `async function run(ctx: any) {
          const paper = await fetchPaper();
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
      },
      {
        name: "iterates an async source in the body",
        code: `async function run(ctx: any) {
          for await (const page of pages()) {}
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
      },
      {
        name: "awaits I/O in a step's name, which the body evaluates",
        code: `async function run(ctx: any) {
          await ctx.step(await nameFor(), async () => 1);
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
      },
      {
        name: "awaits I/O in askEuropePmc's step name, which the body evaluates",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        async function run(ctx: any) {
          await askEuropePmc(ctx, await nameFor(), "wait", r, async () => 1);
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
      },
      {
        name: "awaits a local function that shares askEuropePmc's name",
        filename: "src/run/run.ts",
        code: `async function askEuropePmc(...args: unknown[]) { return fetchPaper(); }
        async function run(ctx: any) {
          await askEuropePmc(ctx, "paper", "wait", r, async () => {
            return await readPaper();
          });
        }`,
        errors: [
          { messageId: "awaitOutsideStep" },
          { messageId: "awaitOutsideStep" },
        ],
      },
      {
        name: "awaits a function of the same name from another module",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./other.ts";
        async function run(ctx: any) {
          await askEuropePmc(ctx, "paper", "wait", r, async () => 1);
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
      },
      {
        name: "awaits I/O directly in a child context, which replays",
        code: `async function run(ctx: any) {
          await ctx.runInChildContext("paper", async (child: any) => {
            await fetchPaper();
          });
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
      },
    ],
  });
});
