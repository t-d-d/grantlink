import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule, isMethodCallIn, unwrapped } from "./create-rule.ts";

// Ported from podstow's rule of the same name (durable-execution.md).
//
// Without a `retryStrategy` a step falls back to the SDK's default, a few
// attempts over a couple of minutes, chosen by nobody here. Europe PMC asks
// for back-off when it refuses or slows a request, and a model call that
// fails must leave its paper for the next run, so each step says how it
// retries. A step's options that are not an object literal cannot be read,
// and pass.
//
// A step is `step(name, fn, options?)` or, unnamed, `step(fn, options?)`.
// The name may be a literal or an expression such as a variable; the
// function may be inline or a reference.
const STEP = new Set(["step"]);

function isStepName(node: TSESTree.Node): boolean {
  return (
    (node.type === AST_NODE_TYPES.Literal && typeof node.value === "string") ||
    node.type === AST_NODE_TYPES.TemplateLiteral
  );
}

function isInlineFunction(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionExpression
  );
}

function isFunctionLike(node: TSESTree.Node): boolean {
  return (
    isInlineFunction(node) ||
    node.type === AST_NODE_TYPES.Identifier ||
    node.type === AST_NODE_TYPES.MemberExpression
  );
}

function isNameExpression(node: TSESTree.Node): boolean {
  return (
    isStepName(node) ||
    node.type === AST_NODE_TYPES.Identifier ||
    node.type === AST_NODE_TYPES.MemberExpression ||
    node.type === AST_NODE_TYPES.CallExpression
  );
}

// The options argument of a step call, `null` when it has none, or
// `undefined` when the call is not a step this rule can read. It reads each
// argument through the wrappers unwrapped takes off, so `"fetch" as const`
// is a name and `{} as StepConfig` is options with no retry strategy.
function stepOptions(
  args: readonly TSESTree.CallExpressionArgument[],
): TSESTree.Node | null | undefined {
  const [first, second, third] = args.map(unwrapped);
  if (first === undefined) return undefined;
  if (isInlineFunction(first)) return second ?? null;
  if (second === undefined) return undefined;
  if (isStepName(first) && isFunctionLike(second)) return third ?? null;
  if (isNameExpression(first) && isInlineFunction(second)) return third ?? null;
  return undefined;
}

function namesRetryStrategy(node: TSESTree.ObjectExpression): boolean {
  return node.properties.some(
    (property) =>
      property.type === AST_NODE_TYPES.SpreadElement ||
      (!property.computed &&
        ((property.key.type === AST_NODE_TYPES.Identifier &&
          property.key.name === "retryStrategy") ||
          (property.key.type === AST_NODE_TYPES.Literal &&
            property.key.value === "retryStrategy"))),
  );
}

export const requireStepRetryStrategy = createRule({
  name: "require-step-retry-strategy",
  meta: {
    type: "problem",
    docs: {
      description: "Every durable step passes an explicit `retryStrategy`.",
    },
    schema: [],
    messages: {
      missing:
        "This step has no `retryStrategy`, so it retries on the SDK's default. Pass `{ retryStrategy }`, or `{ retryStrategy: () => ({ shouldRetry: false }) }` to fail fast.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        if (!isMethodCallIn(node, STEP)) return;
        const options = stepOptions(node.arguments);
        if (options === undefined) return;
        if (options === null) {
          context.report({ node, messageId: "missing" });
          return;
        }
        if (options.type !== AST_NODE_TYPES.ObjectExpression) return;
        if (namesRetryStrategy(options)) return;
        context.report({ node, messageId: "missing" });
      },
    };
  },
});
