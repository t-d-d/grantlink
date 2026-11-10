import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import {
  createRule,
  insideCheckpointedCallback,
  lookup,
  unwrapped,
} from "./create-rule.ts";

// Ported from podstow's rule of the same name (durable-execution.md).
//
// A durable body runs again from the top on every replay. A clock or random
// read outside a checkpointed callback gives a new value each time, so the
// body can take a different path than the one its checkpoints recorded. A
// child context, parallel and map replay their callbacks, and a step's name
// is evaluated in the body, so none of those count as inside. The rule
// reports at the read itself, once, and does not follow calls.
const NON_DETERMINISTIC: Readonly<Record<string, ReadonlySet<string>>> = {
  Math: new Set(["random"]),
  Date: new Set(["now"]),
  performance: new Set(["now"]),
  crypto: new Set([
    "randomBytes",
    "randomFill",
    "randomFillSync",
    "randomInt",
    "getRandomValues",
    "randomUUID",
  ]),
};

// The object is read through unwrapped, so `(Date as any).now()`,
// `Math!.random()` and `(crypto satisfies Crypto).randomUUID()` count too.
function memberOp(node: TSESTree.MemberExpression): string | undefined {
  if (node.computed) return undefined;
  const object = unwrapped(node.object);
  if (object.type !== AST_NODE_TYPES.Identifier) return undefined;
  if (node.property.type !== AST_NODE_TYPES.Identifier) return undefined;
  const allowed = NON_DETERMINISTIC[object.name];
  return allowed?.has(node.property.name) === true
    ? `${object.name}.${node.property.name}`
    : undefined;
}

export const noNonDeterministicOutsideStep = createRule({
  name: "no-non-deterministic-outside-step",
  meta: {
    type: "problem",
    docs: {
      description:
        "A clock or random read in a durable body must sit inside a step.",
    },
    schema: [],
    messages: {
      nonDeterministicOutsideStep:
        "`{{op}}` is outside every step, so a replay reads a new value. Move it inside `ctx.step(...)`, or add `// eslint-disable-next-line grantlink/no-non-deterministic-outside-step -- <why it is safe>`.",
    },
  },
  defaultOptions: [],
  create(context) {
    // A name `Date` that a local declaration shadows is not the clock. A
    // global variable has no definitions, even when the config lists it.
    const isGlobalDate = (
      callee: TSESTree.Node,
      at: TSESTree.Node,
    ): boolean => {
      const name = unwrapped(callee);
      if (name.type !== AST_NODE_TYPES.Identifier || name.name !== "Date") {
        return false;
      }
      const variable = lookup("Date", context.sourceCode.getScope(at));
      return variable === null || variable.defs.length === 0;
    };
    const report = (node: TSESTree.Node, op: string): void => {
      if (insideCheckpointedCallback(node, context)) return;
      context.report({
        node,
        messageId: "nonDeterministicOutsideStep",
        data: { op },
      });
    };
    return {
      // The callee is read through unwrapped too, so `new (Date as any)()`,
      // `new Date!()` and `(Date as any)()` count. `Date()` without `new`
      // returns the current time as a string, so it reads the clock too.
      NewExpression(node) {
        if (node.arguments.length === 0 && isGlobalDate(node.callee, node)) {
          report(node, "new Date()");
        }
      },
      CallExpression(node) {
        if (isGlobalDate(node.callee, node)) report(node, "Date()");
      },
      // A call reports through its callee, so `Date.now()` and a bare
      // `Math.random` passed as a value each report once.
      MemberExpression(node) {
        const op = memberOp(node);
        if (op === undefined) return;
        const called =
          node.parent.type === AST_NODE_TYPES.CallExpression &&
          node.parent.callee === node;
        report(node, called ? `${op}()` : op);
      },
    };
  },
});
