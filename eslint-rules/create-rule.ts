import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { relative, sep } from "node:path";
import { ESLintUtils } from "@typescript-eslint/utils";
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

// True when an ancestor of the node is a method call named in the set.
export function insideMethodCall(
  node: TSESTree.Node,
  sourceCode: Readonly<TSESLint.SourceCode>,
  names: ReadonlySet<string>,
): boolean {
  return sourceCode
    .getAncestors(node)
    .some((ancestor) => isMethodCallIn(ancestor, names));
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
