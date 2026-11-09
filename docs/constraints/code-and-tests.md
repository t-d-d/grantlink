# Code and tests
Relevance: Any TypeScript, any test or test helper, the gate command, tsconfig*.json, eslint.config.js, vitest.config.ts, package.json, .github/workflows/**
Decision: TypeScript with every strict option, type-aware lint with no warnings, Zod at every boundary, Prettier, and Vitest tiers named by file. The gate is offline.

Why: Agents write the code, so the gate is the first reviewer, and it must
run the same on a laptop, in a cloud session and on a standard runner. A
check a machine runs holds on every change; a convention only a reviewer
holds does not.

## Rules

- Every option `test/code-and-tests.static.ts` lists stays on in
  `tsconfig.base.json`.
- Lint is type-aware, and `npm run lint` allows no warnings. A disable
  comment names its rule and gives its reason.
- Data from outside the code, such as an API reply, a file, the
  environment or a model's reply, is parsed with a Zod schema before use.
- Prettier formats the code. Prose is formatted by hand.
- A test's file name sets its tier:

  | Tier | File name | In the gate | May touch |
  | --- | --- | --- | --- |
  | Static | `*.static.ts` | Yes | The repo's own files, read only |
  | Unit | `*.test.ts` | Yes | Memory only |
  | Integration | `*.int.ts` | Yes | Loopback only: local fakes and recorded responses |
  | Live | `*.live.ts` | No | The deployed page, reading only |
  | Conformance | `*.conformance.ts` | No | Setup outside the repo, such as GitHub's settings, read only |

- An assertion goes in the lowest tier that can see it.
- Every tier in the gate loads `test/offline.ts`, which refuses any
  connection or lookup past loopback.
- No test in the gate names a key or a token.
- `npm run gate` runs format, lint, types and the tiers in the gate. CI
  runs the same command.
- Write the failing test first, and watch it fail for the reason you
  expect.

## Do not

- Weaken or delete a test to get the gate green.
- Widen a tier's pattern to bare `*.ts`.
- Call the real model, Europe PMC or AWS from the gate. The eval runs
  apart from it.
- Add a second test runner.

## Judgment

Whether a schema really sits at every boundary is for review: no check
finds a boundary that skips one.

History: #11
