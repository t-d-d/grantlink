import { relative, sep } from "node:path";
import { AST_NODE_TYPES, ESLintUtils } from "@typescript-eslint/utils";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

// Each rule's docs live in the constraint file that names it.
export const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/t-d-d/grantlink/blob/main/eslint-rules/${name}.ts`,
);

// The SDK's durable operations on a context (@aws/durable-execution-sdk-js).
export const DURABLE_METHODS = new Set([
  "step",
  "wait",
  "waitForCallback",
  "waitForCondition",
  "runInChildContext",
  "parallel",
  "map",
  "invoke",
  "createCallback",
]);

// A method call `<receiver>.<name>(...)` whose name is in the set.
export function isMethodCallIn(
  node: TSESTree.Node,
  names: ReadonlySet<string>,
): node is TSESTree.CallExpression & {
  callee: TSESTree.MemberExpression;
} {
  return (
    node.type === AST_NODE_TYPES.CallExpression &&
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    !node.callee.computed &&
    node.callee.property.type === AST_NODE_TYPES.Identifier &&
    names.has(node.callee.property.name)
  );
}

// The operations that checkpoint their callback as a unit: a step, the
// submitter of waitForCallback and the check of waitForCondition. A child
// context, parallel and map run their callbacks again on every replay.
export const CHECKPOINTS_CALLBACK = new Set([
  "step",
  "waitForCallback",
  "waitForCondition",
]);

// True when the node sits inside a function passed to an operation that
// checkpoints its callback. The operation's other arguments, such as the
// step's name, are evaluated in the body on every replay, so they do not
// count.
export function insideCheckpointedCallback(
  node: TSESTree.Node,
  sourceCode: Readonly<TSESLint.SourceCode>,
): boolean {
  const ancestors = sourceCode.getAncestors(node);
  return ancestors.some((fn, i) => {
    const call = ancestors[i - 1];
    return (
      (fn.type === AST_NODE_TYPES.ArrowFunctionExpression ||
        fn.type === AST_NODE_TYPES.FunctionExpression) &&
      call !== undefined &&
      isMethodCallIn(call, CHECKPOINTS_CALLBACK) &&
      call.arguments.includes(fn)
    );
  });
}

// Resolve a name from a scope outward. Null means an implicit global or a
// shape the caller cannot resolve, so it declines rather than guess.
export function lookup(
  name: string,
  scope: TSESLint.Scope.Scope | null,
): TSESLint.Scope.Variable | null {
  for (let s = scope; s !== null; s = s.upper) {
    const variable = s.set.get(name);
    if (variable !== undefined) return variable;
  }
  return null;
}

// The file's path from the directory ESLint runs in, with forward slashes.
export function repoPath(context: { filename: string; cwd: string }): string {
  return relative(context.cwd, context.filename).split(sep).join("/");
}
