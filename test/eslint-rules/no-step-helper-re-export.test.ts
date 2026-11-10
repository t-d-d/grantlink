import { afterAll, describe, it } from "vitest";
import { noStepHelperReExport } from "../../eslint-rules/no-step-helper-re-export.ts";
import { ruleTester } from "../rule-tester.ts";
import { WRAPPED_STEP_HELPERS } from "./wrapped-step-helpers.ts";

const tester = ruleTester({ afterAll, describe, it });

// Ways for owed.ts to wrap its own askEuropePmc when it aliases it locally
// (#436), as the TypeScript wrappers and the comma operator (#429) allow:
// each gives the wrapper's description and the alias's initialiser.
const OWN_MODULE_WRAPPERS: readonly (readonly [string, string])[] = [
  ["asserted with as", "askEuropePmc as typeof askEuropePmc"],
  ["asserted with angle brackets", "<typeof askEuropePmc>askEuropePmc"],
  ["checked with satisfies", "askEuropePmc satisfies typeof askEuropePmc"],
  ["with a non-null assertion", "askEuropePmc!"],
  ["given type arguments", "askEuropePmc<number>"],
  ["in brackets", "(askEuropePmc)"],
  [
    "in brackets and asserted with as",
    "((askEuropePmc) as typeof askEuropePmc)",
  ],
  ["through the comma operator", "(0, askEuropePmc)"],
  [
    "through the comma operator and asserted with as",
    "(0, askEuropePmc as typeof askEuropePmc)",
  ],
];

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
        name: "exports a local alias of a function that shares askEuropePmc's name",
        filename: "src/run/run.ts",
        code: `function askEuropePmc() {}
        const ask = askEuropePmc;
        export { ask };`,
      },
      {
        name: "exports a local alias of askEuropePmc under the helper's own name from its own module",
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        const impl = askEuropePmc;
        export { impl as askEuropePmc };`,
      },
      {
        name: "exports under the helper's own name an alias of a local alias of askEuropePmc written after the alias reads it, from its own module",
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        function somethingElse() {}
        let impl: any = askEuropePmc;
        const ask = impl;
        impl = somethingElse;
        export { ask as askEuropePmc };`,
      },
      {
        name: "exports a local alias of another function in the helper's module",
        filename: "src/run/owed.ts",
        code: `function somethingElse() {}
        const ask = somethingElse;
        export { ask };`,
      },
      ...OWN_MODULE_WRAPPERS.map(([wrapper, init]) => ({
        name: `exports a local alias of askEuropePmc ${wrapper} under the helper's own name from its own module`,
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        const impl = ${init};
        export { impl as askEuropePmc };`,
      })),
      {
        name: "exports a local alias of another function asserted as askEuropePmc's type in the helper's module",
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        async function somethingElse() {}
        const ask = somethingElse as typeof askEuropePmc;
        export { ask };`,
      },
      {
        name: "exports a local function that shares askEuropePmc's name as the default",
        filename: "src/run/run.ts",
        code: `function askEuropePmc() {}
        export default askEuropePmc;`,
      },
      {
        name: "exports a default function declaration that shares askEuropePmc's name from another module",
        filename: "src/run/run.ts",
        code: `export default async function askEuropePmc() {}`,
      },
      {
        name: "exports another function as a default function declaration from the helper's module",
        filename: "src/run/owed.ts",
        code: `export default async function somethingElse() {}`,
      },
      {
        name: "exports an anonymous default function declaration from the helper's module",
        filename: "src/run/owed.ts",
        code: `export default async function () {}`,
      },
    ],
    invalid: [
      ...WRAPPED_STEP_HELPERS.filter(
        (shape) => !shape.callee.endsWith("?."),
      ).map((shape) => ({
        name: `exports askEuropePmc reached through ${shape.name} as a constant`,
        filename: "src/run/run.ts",
        code: `${shape.prelude}
        export const exported = ${shape.callee};`,
        errors: [{ messageId: "reExport" as const }],
      })),
      ...OWN_MODULE_WRAPPERS.flatMap(([wrapper, init]) => [
        {
          name: `exports a local alias of askEuropePmc ${wrapper} from its own module`,
          filename: "src/run/owed.ts",
          code: `async function askEuropePmc() {}
        const ask = ${init};
        export { ask };`,
          errors: [{ messageId: "reExport" as const }],
        },
        {
          name: `exports an alias of a local alias of askEuropePmc ${wrapper} as the default from its own module`,
          filename: "src/run/owed.ts",
          code: `async function askEuropePmc() {}
        const first = ${init};
        const ask = first;
        export default ask;`,
          errors: [{ messageId: "reExport" as const }],
        },
      ]),
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
        name: "exports askEuropePmc as a default function declaration from its own module",
        filename: "src/run/owed.ts",
        code: `export default async function askEuropePmc() {}`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports logOnly as a default function declaration from its own module",
        filename: "src/run/log-only.ts",
        code: `export default function logOnly() {}`,
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
        name: "exports a local alias of askEuropePmc from its own module",
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        const ask = askEuropePmc;
        export { ask };`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports a local alias of askEuropePmc as the default from its own module",
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        const ask = askEuropePmc;
        export default ask;`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports an alias of a local alias of askEuropePmc from its own module",
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        const first = askEuropePmc;
        const ask = first;
        export { ask };`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports a local alias of askEuropePmc when askEuropePmc is itself an alias in its own module",
        filename: "src/run/owed.ts",
        code: `async function impl() {}
        const askEuropePmc = impl;
        const ask = askEuropePmc;
        export { ask };`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports a constant that aliases a local alias of askEuropePmc from its own module",
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        const first = askEuropePmc;
        export const ask = first;`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports a local alias of askEuropePmc that is written again later from its own module",
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        function somethingElse() {}
        let ask = askEuropePmc;
        ask = somethingElse;
        export { ask };`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports a local alias of askEuropePmc that is written again later under the helper's own name from its own module",
        filename: "src/run/owed.ts",
        code: `async function askEuropePmc() {}
        function somethingElse() {}
        let impl = askEuropePmc;
        impl = somethingElse;
        export { impl as askEuropePmc };`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports an alias of an imported askEuropePmc that is written again later",
        filename: "src/run/run.ts",
        code: `import { askEuropePmc } from "./owed.ts";
        function somethingElse() {}
        let ask = askEuropePmc;
        ask = somethingElse;
        export { ask };`,
        errors: [{ messageId: "reExport" }],
      },
      {
        name: "exports an alias of askEuropePmc read from a namespace import that is written again later",
        filename: "src/run/run.ts",
        code: `import * as owed from "./owed.ts";
        function somethingElse() {}
        let ask = owed.askEuropePmc;
        ask = somethingElse;
        export default ask;`,
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
