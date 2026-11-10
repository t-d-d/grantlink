import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";
import { rules as grantlinkRules } from "./eslint-rules/index.ts";

// Type-aware lint with no warnings allowed (docs/constraints/code-and-tests.md).
// Rules that bind particular modules, such as the store or the model, are
// added here by the slices that land their constraint files.

// Test files are left out of the rules below: a conformance check reads the
// bucket with S3's own client, a test may write the shapes a rule refuses in
// order to pin them, and a test of a run is not a durable body.
const tests = [
  "**/*.static.ts",
  "**/*.test.ts",
  "**/*.int.ts",
  "**/*.live.ts",
  "**/*.conformance.ts",
];
export default defineConfig(
  globalIgnores(["node_modules/", "coverage/", ".serverless/"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    plugins: { grantlink: { rules: grantlinkRules } },
  },
  {
    // A run's durable body and its steps (docs/constraints/durable-execution.md).
    files: ["src/run/**/*.ts"],
    ignores: tests,
    rules: {
      "grantlink/no-await-outside-step": "error",
      "grantlink/no-non-deterministic-outside-step": "error",
      "grantlink/no-closure-in-durable-operations": "error",
      "grantlink/no-nested-durable-operations": "error",
      "grantlink/require-step-retry-strategy": "error",
    },
  },
  {
    files: ["src/**/*.ts", "evals/**/*.ts"],
    ignores: tests,
    rules: {
      // One way in to each store (docs/constraints/storage.md).
      "grantlink/only-owner-imports": [
        "error",
        {
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
        },
      ],
      // One model, in one place (docs/constraints/model-calls.md).
      "grantlink/model-call-in-model-module": [
        "error",
        { owner: "src/extract/model.ts" },
      ],
      // No text in logs (docs/constraints/personal-data.md).
      "grantlink/no-banned-log-fields": "error",
      // A step helper is reached only from its own module, so the durable
      // rules can see it (docs/constraints/durable-execution.md).
      "grantlink/no-step-helper-re-export": "error",
    },
  },
  {
    // The eval's fingerprint covers what it runs (docs/constraints/evals.md).
    files: ["src/extract/**/*.ts", "src/shared/**/*.ts", "evals/**/*.ts"],
    ignores: tests,
    rules: {
      "grantlink/imports-within": [
        "error",
        { paths: ["src/extract", "src/shared", "evals"] },
      ],
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
