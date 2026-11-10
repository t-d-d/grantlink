import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { TSESLint } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import {
  createRule,
  DURABLE_METHODS,
  methodCallIn,
  stepHelperOf,
  walkAliases,
} from "./create-rule.ts";

// Ported from podstow's rule of the same name (durable-execution.md).
//
// A durable operation called on a context inside another operation on the
// same context replays out of step with the parent's checkpoints. Nest
// through `runInChildContext` and use the child it hands you. The rule
// follows aliases as walkAliases does, so `const same = ctx` or
// `let same = ctx` is the same context, even if it is written again later,
// and resolves by binding, so a shadowing parameter is a different one. A
// step helper such as askEuropePmc counts as an operation on the context it
// is given first.

export const noNestedDurableOperations = createRule({
  name: "no-nested-durable-operations",
  meta: {
    type: "problem",
    docs: {
      description:
        "A durable operation must not use the context of an operation it sits inside.",
    },
    schema: [],
    messages: {
      sameContextUsage:
        'Context "{{name}}" is used inside its own durable operation. Nest through `runInChildContext` and use the child context.',
    },
  },
  defaultOptions: [],
  create(context) {
    const { sourceCode } = context;
    const stack: (TSESLint.Scope.Variable | null)[] = [];
    const receiverRoot = (
      receiver: TSESTree.Node,
    ): TSESLint.Scope.Variable | null => {
      if (receiver.type !== AST_NODE_TYPES.Identifier) return null;
      return walkAliases(receiver, context)?.chain.at(-1) ?? null;
    };
    // The context a durable operation or a step helper uses, if the call is
    // one.
    const contextOf = (node: TSESTree.CallExpression): TSESTree.Node | null => {
      const operation = methodCallIn(node, DURABLE_METHODS);
      if (operation !== null) return operation.object;
      if (stepHelperOf(node, context, "any") !== null)
        return node.arguments[0] ?? null;
      return null;
    };
    return {
      CallExpression(node) {
        const receiver = contextOf(node);
        if (receiver === null) return;
        const root = receiverRoot(receiver);
        if (root !== null && stack.includes(root)) {
          context.report({
            node,
            messageId: "sameContextUsage",
            data: { name: sourceCode.getText(receiver) },
          });
        }
        stack.push(root);
      },
      "CallExpression:exit"(node: TSESTree.CallExpression) {
        if (contextOf(node) !== null) stack.pop();
      },
    };
  },
});
