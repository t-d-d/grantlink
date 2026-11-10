import { afterAll, describe, it } from "vitest";
import { noStepHelperReExport } from "../../eslint-rules/no-step-helper-re-export.ts";
import { ruleTester } from "../rule-tester.ts";

const tester = ruleTester({ afterAll, describe, it });

describe("fitness: a step helper is reached only from its own module (durable-execution.md)", () => {
  tester.run("no-step-helper-re-export", noStepHelperReExport, {
    valid: [
      {
        name: "imports askEuropePmc and calls it",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        export async function run(ctx: any) {
          return askEuropePmc(ctx, "paper", "wait", r, async () => 1);
        }`,
      },
      {
        name: "re-exports a type from the helper's module",
        filename: "src/run/run.ts",
        code: `export type { Owed } from "./owed.ts";`,
      },
      {
        name: "re-exports another name from the helper's module",
        filename: "src/run/run.ts",
        code: `export { somethingElse } from "./owed.ts";`,
      },
      {
        name: "re-exports askEuropePmc's name from another module",
        filename: "src/run/run.ts",
        code: `export { askEuropePmc } from "./other.ts";`,
      },
      {
        name: "exports askEuropePmc under its own name from its own module",
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        export { askEuropePmc };`,
      },
      {
        name: "exports a local function that shares askEuropePmc's name",
        filename: "src/run/run.ts",
        code: `function askEuropePmc() {}
        export { askEuropePmc };`,
      },
      {
        name: "exports a constant from another name in the helper's module",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        export const other = owed.somethingElse;`,
      },
      {
        name: "exports a local function that shares askEuropePmc's name as the default",
        filename: "src/run/run.ts",
        code: `function askEuropePmc() {}
        export default askEuropePmc;`,
      },
    ],
    invalid: [
      {
        name: "re-exports askEuropePmc from its module",
        filename: "src/run/run.ts",
        code: `export { askEuropePmc } from "./owed.ts";`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "re-exports askEuropePmc under another name",
        filename: "src/run/papers/index.ts",
        code: `export { askEuropePmc as ask } from "../owed";`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "re-exports everything from the helper's module",
        filename: "src/run/run.ts",
        code: `export * from "./owed.js";`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "re-exports the helper's module as a namespace",
        filename: "src/run/run.ts",
        code: `export * as owed from "./owed.ts";`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports an imported askEuropePmc",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        export { askEuropePmc };`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports an imported logOnly as the default",
        filename: "src/run/run.ts",
        code: `import { logOnly } from "./log-only.ts";
        export default logOnly;`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports a local alias of askEuropePmc destructured from a namespace import",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        const { askEuropePmc: ask } = owed;
        export { ask };`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports a namespace import of the helper's module",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        export { owed };`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports askEuropePmc under another name from its own module",
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        export { askEuropePmc as ask };`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports askEuropePmc as the default from its own module",
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        export default askEuropePmc;`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports askEuropePmc as a constant under another name from its own module",
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        export const ask = askEuropePmc;`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports an imported askEuropePmc as a constant",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        export const ask = askEuropePmc;`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports askEuropePmc read from a namespace import as a constant",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        export const ask = owed.askEuropePmc;`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports askEuropePmc read from a namespace import as the default",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        export default owed["askEuropePmc"];`,
        errors: [{ messageId: "reExport" }],
      },
    ],
  });
});
