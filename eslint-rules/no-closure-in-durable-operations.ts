import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { createRule, isMethodCallIn, lookup } from "./create-rule.ts";

// Ported from podstow's rule of the same name (durable-execution.md).
//
// A replay skips a step that has already finished and hands back its saved
// result. A change the step's callback made to an outer variable happens on
// the first pass and not on the replay, so the state after the step differs
// between the two. Writes through an outer object (`totals.papers += 1`)
// count too. The scope manager decides what is outer.
const DURABLE_CALLBACKS = new Set([
  "step",
  "runInChildContext",
  "waitForCondition",
  "waitForCallback",
]);

type Callback = TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;

function callbackOf(call: TSESTree.CallExpression): Callback | undefined {
  return call.arguments.find(
    (arg): arg is Callback =>
      arg.type === AST_NODE_TYPES.ArrowFunctionExpression ||
      arg.type === AST_NODE_TYPES.FunctionExpression,
  );
}

function rootIdentifier(node: TSESTree.Node): TSESTree.Identifier | undefined {
  let current = node;
  while (current.type === AST_NODE_TYPES.MemberExpression)
    current = current.object;
  return current.type === AST_NODE_TYPES.Identifier ? current : undefined;
}

function isWithin(
  scope: TSESLint.Scope.Scope,
  outer: TSESLint.Scope.Scope,
): boolean {
  for (let s: TSESLint.Scope.Scope | null = scope; s !== null; s = s.upper) {
    if (s === outer) return true;
  }
  return false;
}

export const noClosureInDurableOperations = createRule({
  name: "no-closure-in-durable-operations",
  meta: {
    type: "problem",
    docs: {
      description:
        "A durable operation's callback must not change a variable from outside it.",
    },
    schema: [],
    messages: {
      closureVariableUsage:
        'The callback changes "{{name}}" from an outer scope. A replay skips the finished step, so the change happens once and not again. Return the value from the step instead.',
    },
  },
  defaultOptions: [],
  create(context) {
    const { sourceCode } = context;
    // The innermost durable callback each write sits in owns the report, so
    // a write inside nested callbacks reports once.
    const innermostCallback = (node: TSESTree.Node): Callback | undefined => {
      const ancestors = sourceCode.getAncestors(node);
      for (let i = ancestors.length - 1; i > 0; i--) {
        const fn = ancestors[i];
        const call = ancestors[i - 1];
        if (
          fn !== undefined &&
          call !== undefined &&
          isMethodCallIn(call, DURABLE_CALLBACKS) &&
          callbackOf(call) === fn
        ) {
          return callbackOf(call);
        }
      }
      return undefined;
    };
    const check = (target: TSESTree.Node): void => {
      const root = rootIdentifier(target);
      if (root === undefined) return;
      const callback = innermostCallback(target);
      if (callback === undefined) return;
      const variable = lookup(root.name, sourceCode.getScope(root));
      if (variable === null) return;
      if (isWithin(variable.scope, sourceCode.getScope(callback))) return;
      context.report({
        node: root,
        messageId: "closureVariableUsage",
        data: { name: root.name },
      });
    };
    return {
      AssignmentExpression(node) {
        check(node.left);
      },
      UpdateExpression(node) {
        check(node.argument);
      },
    };
  },
});
