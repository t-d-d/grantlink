import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "./create-rule.ts";

// Ported from podstow's rule of the same name (durable-execution.md).
//
// Without a `retryStrategy` a step falls back to the SDK's default, a few
// attempts over a couple of minutes, chosen by nobody here. Europe PMC asks
// for back-off when it refuses or slows a request, and a model call that
// fails must leave its paper for the next run, so each step says how it
// retries. A step's options that are not an object literal cannot be read,
// and pass.
function isStepName(node: TSESTree.Node): boolean {
  return (
    (node.type === AST_NODE_TYPES.Literal && typeof node.value === "string") ||
    node.type === AST_NODE_TYPES.TemplateLiteral
  );
}

function isFunctionLike(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.Identifier ||
    node.type === AST_NODE_TYPES.MemberExpression
  );
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
        const { callee } = node;
        if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed)
          return;
        if (callee.property.type !== AST_NODE_TYPES.Identifier) return;
        if (callee.property.name !== "step") return;
        const [name, fn, options] = node.arguments;
        if (name === undefined || fn === undefined) return;
        if (!isStepName(name) || !isFunctionLike(fn)) return;
        if (options === undefined) {
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
