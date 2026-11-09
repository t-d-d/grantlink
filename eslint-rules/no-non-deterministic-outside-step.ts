import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import {
  createRule,
  DURABLE_METHODS,
  insideMethodCall,
} from "./create-rule.ts";

// Ported from podstow's rule of the same name (durable-execution.md).
//
// A durable body runs again from the top on every replay. A clock or random
// read outside a durable operation gives a new value each time, so the body
// can take a different path than the one its checkpoints recorded. The rule
// reports at the read itself, once, and does not follow calls.
const NON_DETERMINISTIC: Readonly<Record<string, ReadonlySet<string>>> = {
  Math: new Set(["random"]),
  Date: new Set(["now"]),
  performance: new Set(["now"]),
  crypto: new Set(["randomBytes", "getRandomValues", "randomUUID"]),
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

export const noNonDeterministicOutsideStep = createRule({
  name: "no-non-deterministic-outside-step",
  meta: {
    type: "problem",
    docs: {
      description:
        "A clock or random read in a durable body must sit inside a durable operation.",
    },
    schema: [],
    messages: {
      nonDeterministicOutsideStep:
        "`{{op}}` is outside every durable operation, so a replay reads a new value. Move it inside `ctx.step(...)`, or add `// eslint-disable-next-line grantlink/no-non-deterministic-outside-step -- <why it is safe>`.",
    },
  },
  defaultOptions: [],
  create(context) {
    const { sourceCode } = context;
    const report = (node: TSESTree.Node, op: string): void => {
      if (insideMethodCall(node, sourceCode, DURABLE_METHODS)) return;
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
          node.arguments.length === 0
        ) {
          report(node, "new Date()");
        }
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
