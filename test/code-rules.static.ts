import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { root } from "./repo.ts";

// The lint rules behind four constraint files are on where each file says,
// in the config `npm run lint` reads. Each rule's own behaviour is pinned in
// test/eslint-rules/.
const eslint = new ESLint({ cwd: root });

async function setting(path: string, rule: string): Promise<unknown[]> {
  const config = (await eslint.calculateConfigForFile(path)) as {
    rules?: Record<string, unknown[]>;
  };
  return config.rules?.[rule] ?? [];
}

const severity = async (path: string, rule: string): Promise<unknown> =>
  (await setting(path, rule))[0];

const options = async (path: string, rule: string): Promise<unknown> =>
  (await setting(path, rule))[1];

const ERROR = 2;

describe("fitness: durable bodies stay deterministic (durable-execution.md)", () => {
  const rules = [
    "grantlink/no-await-outside-step",
    "grantlink/no-non-deterministic-outside-step",
    "grantlink/no-closure-in-durable-operations",
    "grantlink/no-nested-durable-operations",
    "grantlink/require-step-retry-strategy",
  ];

  it.each(rules)("%s is an error in src/run/", async (rule) => {
    expect(await severity("src/run/handler.ts", rule)).toBe(ERROR);
    expect(await severity("src/run/steps/paper.ts", rule)).toBe(ERROR);
  });

  it.each(rules)("%s is off for a test in src/run/", async (rule) => {
    expect(await severity("src/run/handler.test.ts", rule)).toBeUndefined();
  });
});

describe("fitness: a step helper is reached only from its own module (durable-execution.md)", () => {
  const rule = "grantlink/no-step-helper-re-export";

  it.each(["src/run/handler.ts", "src/pipeline/steps.ts", "src/index.ts"])(
    "is an error in %s",
    async (path) => {
      expect(await severity(path, rule)).toBe(ERROR);
    },
  );

  it("is off for a test", async () => {
    expect(await severity("src/run/owed.int.ts", rule)).toBeUndefined();
  });
});

describe("fitness: one way in to each store (storage.md)", () => {
  const rule = "grantlink/only-owner-imports";

  it.each(["src/run/handler.ts", "src/extract/rules.ts", "evals/run.ts"])(
    "is an error in %s",
    async (path) => {
      expect(await severity(path, rule)).toBe(ERROR);
    },
  );

  it("gives DynamoDB to the table module and S3 to the bucket module", async () => {
    expect(await options("src/run/handler.ts", rule)).toEqual({
      owners: [
        {
          owner: "src/store/table.ts",
          modules: [
            "@aws-sdk/client-dynamodb",
            "@aws-sdk/lib-dynamodb",
            "@aws-sdk/util-dynamodb",
          ],
        },
        {
          owner: "src/store/bucket.ts",
          modules: [
            "@aws-sdk/client-s3",
            "@aws-sdk/lib-storage",
            "@aws-sdk/s3-request-presigner",
          ],
        },
      ],
    });
  });
});

describe("fitness: one model, in one place (model-calls.md)", () => {
  const rule = "grantlink/model-call-in-model-module";

  it.each(["src/run/handler.ts", "src/extract/rules.ts", "evals/run.ts"])(
    "is an error in %s",
    async (path) => {
      expect(await severity(path, rule)).toBe(ERROR);
      expect(await options(path, rule)).toEqual({
        owner: "src/extract/model.ts",
      });
    },
  );
});

describe("fitness: no text in logs (personal-data.md)", () => {
  const rule = "grantlink/no-banned-log-fields";

  it.each([
    "src/run/handler.ts",
    "src/store/table.ts",
    "src/extract/model.ts",
    "evals/run.ts",
  ])("is an error in %s", async (path) => {
    expect(await severity(path, rule)).toBe(ERROR);
  });
});

describe("fitness: the fingerprint covers what the eval runs (evals.md)", () => {
  const rule = "grantlink/imports-within";

  it.each(["src/extract/rules.ts", "src/shared/pmcid.ts", "evals/run.ts"])(
    "is an error in %s, bound to the fingerprinted paths",
    async (path) => {
      expect(await severity(path, rule)).toBe(ERROR);
      expect(await options(path, rule)).toEqual({
        paths: ["src/extract", "src/shared", "evals"],
      });
    },
  );

  it("is off outside them", async () => {
    expect(await severity("src/run/handler.ts", rule)).toBeUndefined();
  });

  it("binds the same paths the fingerprint hashes, but its workflow and lockfile", async () => {
    const { INPUTS } = await import("../evals/fingerprint.ts");
    expect(INPUTS.filter((path) => !/\.(?:yml|json)$/u.test(path))).toEqual([
      "src/extract",
      "src/shared",
      "evals",
    ]);
  });
});
