import { RuleTester } from "@typescript-eslint/rule-tester";

interface Hooks {
  afterAll: typeof RuleTester.afterAll;
  describe: typeof RuleTester.describe;
  it: typeof RuleTester.it & { only: typeof RuleTester.itOnly };
}

// typescript-eslint's RuleTester, running each case as a Vitest test. Each
// test passes Vitest's hooks in, because a file that imports Vitest is
// itself a test and needs a tier (code-and-tests.md).
//
// `cwd` is the directory ESLint runs in, which the tester otherwise takes
// from the process. A case's relative filename is relative to it, as it is
// for `cd <cwd> && npx eslint <filename>`.
export function ruleTester(
  { afterAll, describe, it }: Hooks,
  { cwd }: { cwd?: string } = {},
): RuleTester {
  RuleTester.afterAll = afterAll;
  RuleTester.describe = describe;
  RuleTester.it = it;
  RuleTester.itOnly = it.only;
  return new RuleTester(
    cwd === undefined
      ? undefined
      : { languageOptions: { parserOptions: { tsconfigRootDir: cwd } } },
  );
}
