import { posix, relative, sep } from "node:path";
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

// What a rule needs from its context to resolve a name to its binding.
export interface Resolver {
  sourceCode: Readonly<TSESLint.SourceCode>;
  filename: string;
  cwd: string;
}

// Functions in src/run/ that take a context as their first argument and run
// some of their other arguments inside a step, keyed by the module that
// exports them and the exported name, with those arguments' positions.
// askEuropePmc runs `read` as its step and calls `retry` from inside it, and
// askForPaper calls `sent` there too. logOnly runs `log` as its step. The
// rules treat a call to one as a durable operation on that context and those
// arguments as a step's callback. They resolve the callee to its binding, so
// a caller may import one under any name, and a function that only shares
// the name is not one.
export interface StepHelper {
  module: string;
  name: string;
  callbacks: readonly number[];
}

export const STEP_HELPERS: readonly StepHelper[] = [
  { module: "src/run/owed.ts", name: "askEuropePmc", callbacks: [3, 4] },
  { module: "src/run/owed.ts", name: "askForPaper", callbacks: [3, 4, 5] },
  { module: "src/run/log-only.ts", name: "logOnly", callbacks: [2] },
];

// The step helper a call calls, if its callee resolves to one: a named
// import `<name>(...)`, or a namespace import `<ns>.<name>(...)` or
// `<ns>["<name>"](...)`. A local function, an import from another module or
// a computed key that is not a constant string is not one. A re-export would hide the
// helper's module, so no-step-helper-re-export refuses one.
export function stepHelperOf(
  node: TSESTree.Node,
  resolver: Resolver,
): StepHelper | null {
  if (node.type !== AST_NODE_TYPES.CallExpression) return null;
  const { callee } = node;
  if (callee.type === AST_NODE_TYPES.Identifier) {
    const binding = importOf(callee, resolver);
    if (typeof binding?.name !== "string") return null;
    return helperNamed(binding.module, binding.name);
  }
  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    callee.object.type === AST_NODE_TYPES.Identifier
  ) {
    const name = memberName(callee);
    if (name === null) return null;
    const binding = importOf(callee.object, resolver);
    if (binding?.name !== null) return null;
    return helperNamed(binding.module, name);
  }
  return null;
}

// The name a member expression reads: `a.b`, `a["b"]` or a template key
// with nothing interpolated.
export function memberName(node: TSESTree.MemberExpression): string | null {
  const { property } = node;
  if (!node.computed) {
    return property.type === AST_NODE_TYPES.Identifier ? property.name : null;
  }
  if (property.type === AST_NODE_TYPES.TemplateLiteral) {
    return property.expressions.length === 0
      ? (property.quasis[0]?.value.cooked ?? null)
      : null;
  }
  return property.type === AST_NODE_TYPES.Literal &&
    typeof property.value === "string"
    ? property.value
    : null;
}

// What an identifier's binding imports from a relative module: a named
// import, or the whole module (name null) for a namespace import. Null for
// any other binding.
export function importOf(
  identifier: TSESTree.Identifier,
  resolver: Resolver,
): { module: string; name: string | null } | null {
  const variable = lookup(
    identifier.name,
    resolver.sourceCode.getScope(identifier),
  );
  const def = variable?.defs[0];
  if (def?.parent?.type !== AST_NODE_TYPES.ImportDeclaration) return null;
  const module = moduleOf(def.parent.source.value, resolver);
  if (module === null) return null;
  if (def.node.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
    return { module, name: null };
  }
  if (def.node.type !== AST_NODE_TYPES.ImportSpecifier) return null;
  return { module, name: exportedName(def.node.imported) };
}

// The name an import or export specifier gives, as an identifier or a
// string.
export function exportedName(
  node: TSESTree.Identifier | TSESTree.StringLiteral,
): string {
  return node.type === AST_NODE_TYPES.Identifier ? node.name : node.value;
}

// The repo path, without its extension, of the module a relative import in
// this file names. Null for a package.
export function moduleOf(source: string, resolver: Resolver): string | null {
  if (!source.startsWith(".")) return null;
  return withoutExtension(
    posix.normalize(posix.join(posix.dirname(repoPath(resolver)), source)),
  );
}

// The step helper a module exports under a name.
export function helperNamed(module: string, name: string): StepHelper | null {
  return (
    STEP_HELPERS.find(
      (helper) =>
        withoutExtension(helper.module) === module && helper.name === name,
    ) ?? null
  );
}

// True when a module exports any step helper.
export function holdsStepHelper(module: string): boolean {
  return STEP_HELPERS.some(
    (helper) => withoutExtension(helper.module) === module,
  );
}

// A module path without its .ts or .js extension. The bundler resolution in
// tsconfig.base.json lets an import name owed.ts as "./owed", "./owed.js" or
// "./owed.ts", and all three are the same module.
export function withoutExtension(path: string): string {
  return path.replace(/\.[cm]?[jt]s$/, "");
}

// True when `fn` is an argument a step helper runs inside its step.
export function isStepHelperCallback(
  call: TSESTree.Node,
  fn: TSESTree.Node,
  resolver: Resolver,
): boolean {
  if (call.type !== AST_NODE_TYPES.CallExpression) return false;
  const helper = stepHelperOf(call, resolver);
  return helper?.callbacks.some((at) => call.arguments[at] === fn) ?? false;
}

// True when the node sits inside a function passed to an operation that
// checkpoints its callback, or that a step helper runs inside its step.
// The operation's other arguments, such as the step's name, are evaluated
// in the body on every replay, so they do not count.
export function insideCheckpointedCallback(
  node: TSESTree.Node,
  resolver: Resolver,
): boolean {
  const ancestors = resolver.sourceCode.getAncestors(node);
  return ancestors.some((fn, i) => {
    const call = ancestors[i - 1];
    return (
      (fn.type === AST_NODE_TYPES.ArrowFunctionExpression ||
        fn.type === AST_NODE_TYPES.FunctionExpression) &&
      call !== undefined &&
      ((isMethodCallIn(call, CHECKPOINTS_CALLBACK) &&
        call.arguments.includes(fn)) ||
        isStepHelperCallback(call, fn, resolver))
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
