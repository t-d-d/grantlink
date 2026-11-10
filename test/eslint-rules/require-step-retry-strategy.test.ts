import { afterAll, describe, it } from "vitest";
import { requireStepRetryStrategy } from "../../eslint-rules/require-step-retry-strategy.ts";
import { ruleTester } from "../rule-tester.ts";

const tester = ruleTester({ afterAll, describe, it });

describe("fitness: every step names its retry strategy (durable-execution.md)", () => {
  tester.run("require-step-retry-strategy", requireStepRetryStrategy, {
    valid: [
      {
        name: "passes a retry strategy checked with satisfies",
        code: `await ctx.step("fetch", async () => 1, { retryStrategy: paced } satisfies StepConfig);`,
      },
      {
        name: "passes options it cannot read, asserted with as",
        code: `await ctx.step("fetch", async () => 1, stepOptions as StepConfig);`,
      },

      {
        name: "passes a retry strategy",
        code: `await ctx.step("fetch", async () => 1, { retryStrategy: paced });`,
      },
      {
        name: "passes options it cannot read",
        code: `await ctx.step("fetch", async () => 1, stepOptions);`,
      },
      {
        name: "passes a function and options it cannot read",
        code: `await ctx.step(fetchPaper, stepOptions);`,
      },
      {
        name: "is not a durable step",
        code: `wizard.step(2);`,
      },
    ],
    invalid: [
      ...[
        [
          "names the step with as const",
          `ctx.step("fetch" as const, async () => 1);`,
        ],
        [
          "names the step with satisfies",
          `ctx.step("fetch" satisfies string, async () => 1);`,
        ],
        [
          "passes a callback asserted with as",
          `ctx.step("fetch", (async () => 1) as any);`,
        ],
        [
          "passes an unnamed callback asserted with as",
          `ctx.step((async () => 1) as any);`,
        ],
        [
          "passes a function behind a non-null assertion",
          `ctx.step("fetch", fetchPaper!);`,
        ],
        [
          "passes empty options asserted with as",
          `ctx.step("fetch", async () => 1, {} as StepConfig);`,
        ],
        [
          "passes options checked with satisfies",
          `ctx.step("fetch", async () => 1, { serdes } satisfies StepConfig);`,
        ],
        [
          "passes empty options behind a non-null assertion",
          `ctx.step("fetch", async () => 1, {}!);`,
        ],
      ].map(([what, code]) => ({
        name: String(what),
        code: String(code),
        errors: [{ messageId: "missing" as const }],
      })),

      {
        name: "passes no options",
        code: `await ctx.step("fetch", async () => 1);`,
        errors: [{ messageId: "missing" }],
      },
      {
        name: "names the step with a variable and passes no options",
        code: `await ctx.step(stepName, async () => 1);`,
        errors: [{ messageId: "missing" }],
      },
      {
        name: "has no name and passes no options",
        code: `await ctx.step(async () => 1);`,
        errors: [{ messageId: "missing" }],
      },
      {
        name: "passes options without a retry strategy",
        code: "await ctx.step(`paper-${id}`, async () => 1, { serdes });",
        errors: [{ messageId: "missing" }],
      },
    ],
  });
});
