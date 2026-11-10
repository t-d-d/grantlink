import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import {
  createRule,
  isStepHelperCallback,
  lookup,
  outermostWrapper,
  unwrapped,
  methodCallIn,
} from "./create-rule.ts";

// Ported from podstow's rule of the same name (durable-execution.md).
//
// A replay skips a step that has already finished and hands back its saved
// result. A change the step's callback made to an outer variable happens on
// the first pass and not on the replay, so the state after the step differs
// between the two. Writes through an outer object (`totals.papers += 1`,
// `found.push(id)`, `delete totals.papers`) and destructuring into an outer
// variable count too. The scope manager decides what is outer.
//
// A child context, a map item and a parallel branch are skipped the same way
// once they have finished, so a write in their callbacks counts too. While
// one is unfinished its callback runs again on replay, which is why
// no-await-outside-step does not trust them; both rules hold.
const DURABLE_CALLBACKS = new Set([
  "step",
  "runInChildContext",
  "map",
  "parallel",
  "waitForCondition",
  "waitForCallback",
]);

// Methods that change the array, Map or Set they are called on.
const MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "add",
  "delete",
  "clear",
]);

type Callback = TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;

function isCallback(node: TSESTree.Node): node is Callback {
  return (
    node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionExpression
  );
}

// The literal nodes between a call and a callback passed inside it, and the
// wrappers unwrapped takes off around them, as in `[branch] as F[]`.
function isLiteralWrapper(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.ArrayExpression ||
    node.type === AST_NODE_TYPES.ObjectExpression ||
    node.type === AST_NODE_TYPES.Property ||
    unwrapped(node) !== node
  );
}

// The variable a write lands in, through members and the wrappers unwrapped
// takes off: `found` in `found!.push(1)`, `(found as T[]).push(1)` and
// `totals!.papers += 1`.
function rootIdentifier(node: TSESTree.Node): TSESTree.Identifier | undefined {
  let current = unwrapped(node);
  while (current.type === AST_NODE_TYPES.MemberExpression)
    current = unwrapped(current.object);
  return current.type === AST_NODE_TYPES.Identifier ? current : undefined;
}

// The places an assignment target writes: itself, or each target inside a
// destructuring pattern.
function targets(node: TSESTree.Node): TSESTree.Node[] {
  switch (node.type) {
    case AST_NODE_TYPES.ArrayPattern:
      return node.elements.flatMap((element) =>
        element === null ? [] : targets(element),
      );
    case AST_NODE_TYPES.ObjectPattern:
      return node.properties.flatMap((property) =>
        targets(
          property.type === AST_NODE_TYPES.Property
            ? property.value
            : property.argument,
        ),
      );
    case AST_NODE_TYPES.AssignmentPattern:
      return targets(node.left);
    case AST_NODE_TYPES.RestElement:
      return targets(node.argument);
    default:
      return [node];
  }
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
        'The callback changes "{{name}}" from an outer scope. A replay skips the finished operation, so the change happens once and not again. Return the value from the callback instead.',
    },
  },
  defaultOptions: [],
  create(context) {
    const { sourceCode } = context;
    // The innermost durable callback each write sits in owns the report, so
    // a write inside nested callbacks reports once. A callback is a function
    // passed to a durable operation directly, or inside an array or object
    // literal argument, as parallel's branches are, or an argument a step
    // helper such as askEuropePmc runs inside its step. A wrapper such as
    // `(async () => {...}) as F` around the function does not hide it.
    // Knowing a helper here only adds reports, so an alias written again
    // still counts (an inexact walk, #518).
    const innermostCallback = (node: TSESTree.Node): Callback | undefined => {
      const ancestors = sourceCode.getAncestors(node);
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const fn = ancestors[i];
        if (fn === undefined || !isCallback(fn)) continue;
        const at = outermostWrapper(ancestors, i);
        const argument = ancestors[at];
        const call = ancestors[at - 1];
        if (
          argument !== undefined &&
          call !== undefined &&
          isStepHelperCallback(call, argument, context, "any")
        )
          return fn;
        let j = at - 1;
        let parent = ancestors[j];
        while (parent !== undefined && isLiteralWrapper(parent)) {
          j -= 1;
          parent = ancestors[j];
        }
        if (
          parent?.type === AST_NODE_TYPES.CallExpression &&
          methodCallIn(parent, DURABLE_CALLBACKS) !== null &&
          parent.callee !== ancestors[j + 1]
        ) {
          return fn;
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
        for (const target of targets(node.left)) check(target);
      },
      UpdateExpression(node) {
        check(node.argument);
      },
      UnaryExpression(node) {
        if (node.operator === "delete") check(node.argument);
      },
      CallExpression(node) {
        const mutation = methodCallIn(node, MUTATORS);
        if (mutation !== null) check(mutation.object);
      },
    };
  },
});
