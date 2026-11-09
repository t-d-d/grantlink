import { afterAll, describe, it } from "vitest";
import { modelCallInModelModule } from "../../eslint-rules/model-call-in-model-module.ts";
import { ruleTester } from "../rule-tester.ts";

const tester = ruleTester({ afterAll, describe, it });

const options = [{ owner: "src/extract/model.ts" }] as const;

describe("fitness: one model, in one place (model-calls.md)", () => {
  tester.run("model-call-in-model-module", modelCallInModelModule, {
    valid: [
      {
        name: "the model module names OpenRouter and the model",
        filename: "src/extract/model.ts",
        code: `const endpoint = "https://openrouter.ai/api/v1/chat/completions";
          export const MODEL = "anthropic/claude-haiku-5.5";`,
        options,
      },
      {
        name: "another module asks the model module",
        filename: "src/run/handler.ts",
        code: `import { propose } from "../extract/model.ts";`,
        options,
      },
    ],
    invalid: [
      {
        name: "another module calls OpenRouter",
        filename: "src/run/handler.ts",
        code: "await fetch(`https://openrouter.ai/api/v1/chat/completions`);",
        options,
        errors: [{ messageId: "openRouter" }],
      },
      {
        name: "another module names a model",
        filename: "evals/run.ts",
        code: `const model = "anthropic/claude-sonnet-5.5";`,
        options,
        errors: [{ messageId: "modelId" }],
      },
      {
        name: "another module imports a model client",
        filename: "src/extract/rules.ts",
        code: `import OpenAI from "openai";`,
        options,
        errors: [{ messageId: "modelClient" }],
      },
    ],
  });
});
