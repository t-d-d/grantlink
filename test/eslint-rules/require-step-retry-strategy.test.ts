import { afterAll, describe, it } from "vitest";
import { requireStepRetryStrategy } from "../../eslint-rules/require-step-retry-strategy.ts";
import { ruleTester } from "../rule-tester.ts";

const tester = ruleTester({ afterAll, describe, it });

describe("fitness: every step names its retry strategy (durable-execution.md)", () => {
  tester.run("require-step-retry-strategy", requireStepRetryStrategy, {
    valid: [
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
