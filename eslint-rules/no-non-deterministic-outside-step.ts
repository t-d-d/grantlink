import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import type { TSESLint } from "@typescript-eslint/utils";
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

function memberOp(node: TSESTree.MemberExpression): string | undefined {
  if (node.computed) return undefined;
  if (node.object.type !== AST_NODE_TYPES.Identifier) return undefined;
  if (node.property.type !== AST_NODE_TYPES.Identifier) return undefined;
  const allowed = NON_DETERMINISTIC[node.object.name];
  return allowed?.has(node.property.name) === true
    ? `${node.object.name}.${node.property.name}`
    : undefined;
}

// True when the identifier names something the file declares, such as a
// parameter or a class called `Math`, rather than the global. A global the
// config declares has no definition in the file.
function declaredLocally(
  identifier: TSESTree.Identifier,
  sourceCode: Readonly<TSESLint.SourceCode>,
): boolean {
  const variable = lookup(identifier.name, sourceCode.getScope(identifier));
  return (variable?.defs.length ?? 0) > 0;
}

// True when the node is the function a call calls, read through the
// wrappers unwrapped takes off, so `Date.now!()`, `(Date.now as F)()` and
// `(0, Date.now)()` are each a call.
function calledThrough(node: TSESTree.Node): boolean {
  let outer = node;
  while (outer.parent !== undefined && unwrapped(outer.parent) === node) {
    outer = outer.parent;
  }
  return (
    outer.parent?.type === AST_NODE_TYPES.CallExpression &&
    outer.parent.callee === outer
  );
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
    const report = (node: TSESTree.Node, op: string): void => {
      if (insideCheckpointedCallback(node, context)) return;
      context.report({
        node,
        messageId: "nonDeterministicOutsideStep",
        data: { op },
      });
    };
    return {
      NewExpression(node) {
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === "Date" &&
          node.arguments.length === 0 &&
          !declaredLocally(node.callee, context.sourceCode)
        ) {
          report(node, "new Date()");
        }
      },
      // A call reports through its callee, so `Date.now()` and a bare
      // `Math.random` passed as a value each report once. A local that
      // shadows the global, such as a parameter named `Math`, is not read.
      MemberExpression(node) {
        const op = memberOp(node);
        if (op === undefined) return;
        if (
          node.object.type === AST_NODE_TYPES.Identifier &&
          declaredLocally(node.object, context.sourceCode)
        ) {
          return;
        }
        report(node, calledThrough(node) ? `${op}()` : op);
      },
    };
  },
});
