import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { importsWithin } from "../../eslint-rules/imports-within.ts";
import { root } from "../repo.ts";
import { ruleTester } from "../rule-tester.ts";

const tester = ruleTester({ afterAll, describe, it });

const options = [{ paths: ["src/extract", "evals"] }] as const;

describe("fitness: the fingerprint covers what the eval runs (evals.md)", () => {
  tester.run("imports-within", importsWithin, {
    valid: [
      {
        name: "the rules import their config",
        filename: "src/extract/rules.ts",
        code: `import funder from "./funder.json" with { type: "json" };`,
        options,
      },
      {
        name: "the runner imports the rules",
        filename: "evals/run.ts",
        code: `import { findReferences } from "../src/extract/rules.ts";`,
        options,
      },
      {
        name: "a package",
        filename: "evals/report.ts",
        code: `import { z } from "zod";`,
        options,
      },
      {
        name: "a Node built-in",
        filename: "evals/run.ts",
        code: `import { readFileSync } from "node:fs";`,
        options,
      },
    ],
    invalid: [
      {
        name: "the runner imports the store",
        filename: "evals/run.ts",
        code: `import { textBucket } from "../src/store/bucket.ts";`,
        options,
        errors: [{ messageId: "outside" }],
      },
      {
        name: "the rules import the page",
        filename: "src/extract/rules.ts",
        code: `export { found } from "../page/found.ts";`,
        options,
        errors: [{ messageId: "outside" }],
      },
      {
        name: "a dynamic import from outside",
        filename: "evals/run.ts",
        code: `const m = import("../src/log.ts");`,
        options,
        errors: [{ messageId: "outside" }],
      },
      {
        name: "a path that only starts like an input",
        filename: "evals/run.ts",
        code: `import x from "../evals-old/x.ts";`,
        options,
        errors: [{ messageId: "outside" }],
      },
    ],
  });

  // ESLint run from src/, as an editor whose folder is src/ would, names
  // each file from there. The rule still sees the repo's paths.
  describe("run from src/", () => {
    ruleTester({ afterAll, describe, it }, { cwd: join(root, "src") }).run(
      "imports-within",
      importsWithin,
      {
        valid: [
          {
            name: "the rules import their config",
            filename: "extract/rules.ts",
            code: `import funder from "./funder.json" with { type: "json" };`,
            options,
          },
        ],
        invalid: [
          {
            name: "the rules import the page",
            filename: "extract/rules.ts",
            code: `export { found } from "../page/found.ts";`,
            options,
            errors: [{ messageId: "outside" }],
          },
        ],
      },
    );
  });
});
