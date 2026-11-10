// Ways to reach askEuropePmc through a TypeScript wrapper, optional
// chaining (#408) or the comma operator (#429). Each gives the module's
// opening lines and the text that stands before a call's argument list, so
// a rule's tests can write `${shape.callee}(ctx, ...)` in a body that
// follows `shape.prelude`.
export interface WrappedStepHelper {
  name: string;
  prelude: string;
  callee: string;
}

const namespace = `import * as owed from "./owed.ts";`;
const named = `import { askEuropePmc } from "./owed.ts";`;

export const WRAPPED_STEP_HELPERS: readonly WrappedStepHelper[] = [
  {
    name: "a callee asserted with as",
    prelude: namespace,
    callee: "(owed.askEuropePmc as typeof owed.askEuropePmc)",
  },
  {
    name: "a callee asserted with angle brackets",
    prelude: namespace,
    callee: "(<typeof owed.askEuropePmc>owed.askEuropePmc)",
  },
  {
    name: "a callee checked with satisfies",
    prelude: named,
    callee: "(askEuropePmc satisfies typeof askEuropePmc)",
  },
  {
    name: "a callee with a non-null assertion",
    prelude: named,
    callee: "askEuropePmc!",
  },
  {
    name: "a callee given type arguments",
    prelude: named,
    callee: "(askEuropePmc<number>)",
  },
  {
    name: "a namespace asserted with as",
    prelude: namespace,
    callee: "(owed as typeof owed).askEuropePmc",
  },
  {
    name: "a member read with optional chaining",
    prelude: namespace,
    callee: "owed?.askEuropePmc",
  },
  {
    name: "an optional call",
    prelude: named,
    callee: "askEuropePmc?.",
  },
  {
    name: "a member read with optional chaining and asserted with as",
    prelude: namespace,
    callee: "(owed?.askEuropePmc as typeof owed.askEuropePmc)",
  },
  {
    name: "an alias asserted with as",
    prelude: `${namespace}
    const ask = owed.askEuropePmc as typeof owed.askEuropePmc;`,
    callee: "ask",
  },
  {
    name: "an alias checked with satisfies",
    prelude: `${namespace}
    const ask = owed.askEuropePmc satisfies typeof owed.askEuropePmc;`,
    callee: "ask",
  },
  {
    name: "an alias with a non-null assertion",
    prelude: `${namespace}
    const ask = owed.askEuropePmc!;`,
    callee: "ask",
  },
  {
    name: "an alias of a named import asserted with as",
    prelude: `${named}
    const ask = askEuropePmc as typeof askEuropePmc;`,
    callee: "ask",
  },
  {
    name: "an alias read with optional chaining",
    prelude: `${namespace}
    const ask = owed?.askEuropePmc;`,
    callee: "ask",
  },
  {
    name: "an alias destructured from an asserted namespace",
    prelude: `${namespace}
    const { askEuropePmc: ask } = owed as typeof owed;`,
    callee: "ask",
  },
  {
    name: "a member read through the comma operator",
    prelude: namespace,
    callee: "(0, owed.askEuropePmc)",
  },
  {
    name: "a named import read through the comma operator",
    prelude: named,
    callee: "(0, askEuropePmc)",
  },
  {
    name: "a namespace read through the comma operator",
    prelude: namespace,
    callee: "(0, owed).askEuropePmc",
  },
  {
    name: "the comma operator inside an assertion",
    prelude: namespace,
    callee: "((0, owed.askEuropePmc) as typeof owed.askEuropePmc)",
  },
  {
    name: "an assertion inside the comma operator",
    prelude: named,
    callee: "(0, askEuropePmc as typeof askEuropePmc)",
  },
  {
    name: "an alias assigned through the comma operator",
    prelude: `${namespace}
    const ask = (0, owed.askEuropePmc);`,
    callee: "ask",
  },
];
