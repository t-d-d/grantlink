import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { noAwaitOutsideStep } from "../../eslint-rules/no-await-outside-step.ts";
import { root } from "../repo.ts";
import { ruleTester } from "../rule-tester.ts";
import { WRAPPED_STEP_HELPERS } from "./wrapped-step-helpers.ts";

const tester = ruleTester({ afterAll, describe, it });

describe("fitness: no bare await in a durable body (durable-execution.md)", () => {
  tester.run("no-await-outside-step", noAwaitOutsideStep, {
    valid: [
      ...WRAPPED_STEP_HELPERS.map((shape) => ({
        name: `awaits I/O inside askEuropePmc's read, reached through ${shape.name}`,
        filename: "src/run/run.ts",
        code: `${shape.prelude}
        async function run(ctx: any) {
          await ${shape.callee}(ctx, "paper", "wait", r, async () => {
            return await readPaper();
          });
        }`,
      })),
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
        name: "awaits I/O inside askForPaper's read, which runs as its step",
        filename: "src/run/run.ts",
        code: `import { askForPaper } from "./owed.ts";
        async function run(ctx: any) {
          await askForPaper(ctx, "paper", "wait", r, () => sent(), async () => {
            return await readPaper();
          });
        }`,
      },
      {
        name: "awaits logOnly, whose only await is its step",
        filename: "src/run/run.ts",
        code: `import { logOnly } from "./log-only.ts";
        async function run(ctx: any) {
          await logOnly(ctx, "search-ended", () => {
            logSearchEnded();
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
      {
        name: "awaits askEuropePmc imported without the .ts extension",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed";
        async function run(ctx: any) {
          await askEuropePmc(ctx, "paper", "wait", r, async () => readPaper());
        }`,
      },
      {
        name: "awaits askEuropePmc imported with a .js extension",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.js";
        async function run(ctx: any) {
          await askEuropePmc(ctx, "paper", "wait", r, async () => readPaper());
        }`,
      },
      {
        name: "awaits I/O inside askEuropePmc's read, reached through a namespace import",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        async function run(ctx: any) {
          await owed.askEuropePmc(ctx, "paper", "wait", r, async () => {
            return await readPaper();
          });
        }`,
      },
      {
        name: "awaits askEuropePmc reached through a namespace import by a string key",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        async function run(ctx: any) {
          await owed["askEuropePmc"](ctx, "paper", "wait", r, async () => readPaper());
        }`,
      },
      {
        name: "awaits askEuropePmc reached through a namespace import by a template key",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        async function run(ctx: any) {
          await owed[\`askEuropePmc\`](ctx, "paper", "wait", r, async () => readPaper());
        }`,
      },
      {
        name: "awaits I/O inside askEuropePmc's read, reached through a let alias that is never written again",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        let ask = askEuropePmc;
        async function run(ctx: any) {
          await ask(ctx, "paper", "wait", r, async () => {
            return await readPaper();
          });
        }`,
      },
      {
        name: "awaits I/O inside askEuropePmc's read, reached through a destructured alias of a namespace import",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        const { askEuropePmc: ask } = owed;
        async function run(ctx: any) {
          await ask(ctx, "paper", "wait", r, async () => {
            return await readPaper();
          });
        }`,
      },
      {
        name: "awaits I/O inside askEuropePmc's read, reached through a constant read from a namespace import",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        async function run(ctx: any) {
          const ask = owed.askEuropePmc;
          await ask(ctx, "paper", "wait", r, async () => {
            return await readPaper();
          });
        }`,
      },
      {
        name: "awaits askEuropePmc through a constant that renames a named import",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        const ask = askEuropePmc;
        async function run(ctx: any) {
          await ask(ctx, "paper", "wait", r, async () => readPaper());
        }`,
      },
      {
        name: "awaits askEuropePmc through a variable that is never assigned again",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        let { askEuropePmc } = owed;
        async function run(ctx: any) {
          await askEuropePmc(ctx, "paper", "wait", r, async () => readPaper());
        }`,
      },
      {
        name: "awaits I/O inside askEuropePmc's read, reached through an alias destructured by a string key",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        const { "askEuropePmc": ask } = owed;
        async function run(ctx: any) {
          await ask(ctx, "paper", "wait", r, async () => {
            return await readPaper();
          });
        }`,
      },
      {
        name: "awaits askEuropePmc through an alias destructured by a template key",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        const { [\`askEuropePmc\`]: ask } = owed;
        async function run(ctx: any) {
          await ask(ctx, "paper", "wait", r, async () => readPaper());
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
        name: "awaits I/O in askForPaper's step name, which the body evaluates",
        filename: "src/run/run.ts",
        code: `import { askForPaper } from "./owed.ts";
        async function run(ctx: any) {
          await askForPaper(ctx, await nameFor(), "wait", r, () => 0, async () => 1);
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
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
        name: "awaits a namespace import's function that is not a step helper",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        async function run(ctx: any) {
          await owed.somethingElse(ctx, "paper", "wait", r, async () => 1);
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
      },
      {
        name: "awaits askEuropePmc through a namespace import of another module",
        filename: "src/run/run.ts",
        code: `import * as other from "./other.ts";
        async function run(ctx: any) {
          await other.askEuropePmc(ctx, "paper", "wait", r, async () => 1);
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
      },
      {
        name: "awaits a destructured alias of a namespace import's function that is not a step helper",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        const { somethingElse: ask } = owed;
        async function run(ctx: any) {
          await ask(ctx, "paper", "wait", r, async () => 1);
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
      },
      {
        name: "awaits an alias of askEuropePmc that is assigned again",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        let ask = owed.askEuropePmc;
        ask = other;
        async function run(ctx: any) {
          await ask(ctx, "paper", "wait", r, async () => 1);
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
      },
      {
        name: "awaits an alias of an imported askEuropePmc that is assigned again",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        let ask = askEuropePmc;
        ask = other;
        async function run(ctx: any) {
          await ask(ctx, "paper", "wait", r, async () => 1);
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
      },
      {
        name: "awaits an alias with a default, which may not be the helper",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        const { askEuropePmc: ask = other } = owed;
        async function run(ctx: any) {
          await ask(ctx, "paper", "wait", r, async () => 1);
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
      },
      {
        name: "awaits an alias destructured by a computed key that is a variable",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        const askEuropePmc = "somethingElse";
        const { [askEuropePmc]: ask } = owed;
        async function run(ctx: any) {
          await ask(ctx, "paper", "wait", r, async () => 1);
        }`,
        errors: [{ messageId: "awaitOutsideStep" }],
      },
      {
        name: "awaits aliases that name each other before either is set",
        filename: "src/run/run.ts",
        code: `const a = b;
        const b = a;
        async function run(ctx: any) {
          await a(ctx, "paper", "wait", r, async () => 1);
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

  // ESLint run from src/ names the file run/run.ts. The rule still knows
  // askEuropePmc from src/run/owed.ts.
  describe("run from src/", () => {
    ruleTester({ afterAll, describe, it }, { cwd: join(root, "src") }).run(
      "no-await-outside-step",
      noAwaitOutsideStep,
      {
        valid: [
          {
            name: "awaits askEuropePmc, whose only await is its step",
            filename: "run/run.ts",
            code: `import { askEuropePmc } from "./owed.ts";
          async function run(ctx: any) {
            await askEuropePmc(ctx, "paper", "wait", r, async () => readPaper());
          }`,
          },
        ],
        invalid: [
          {
            name: "awaits I/O directly in a durable body",
            filename: "run/run.ts",
            code: `async function run(ctx: any) {
            await fetchPaper();
          }`,
            errors: [{ messageId: "awaitOutsideStep" }],
          },
        ],
      },
    );
  });
});
