import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  AST_NODE_TYPES,
  ESLintUtils,
  TSESLint,
} from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";

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
// `<ns>["<name>"](...)`, either one reached through a local alias that is
// never assigned again (importOf). It looks through type assertions,
// non-null assertions, type arguments and optional chaining (unwrapped), on
// the call, the callee and the namespace alike. A local function, an import
// from another module or a computed key that is not a constant string is
// not one. A re-export would hide the helper's module, so
// no-step-helper-re-export refuses one.
export function stepHelperOf(
  node: TSESTree.Node,
  resolver: Resolver,
): StepHelper | null {
  const call = unwrapped(node);
  if (call.type !== AST_NODE_TYPES.CallExpression) return null;
  const binding = bindingOf(call.callee, resolver);
  if (typeof binding?.name !== "string") return null;
  return helperNamed(binding.module, binding.name);
}

// What an expression reads from a relative module, through the wrappers
// unwrapped takes off: an identifier's import (importOf), or a name read
// from a namespace import `<ns>.<name>` or `<ns>["<name>"]`. Null for
// anything else.
export function bindingOf(
  node: TSESTree.Node,
  resolver: Resolver,
  seen: ReadonlySet<TSESLint.Scope.Variable> = new Set(),
): { module: string; name: string | null } | null {
  const value = unwrapped(node);
  if (value.type === AST_NODE_TYPES.Identifier) {
    return importOf(value, resolver, seen);
  }
  if (value.type !== AST_NODE_TYPES.MemberExpression) return null;
  const object = unwrapped(value.object);
  const name = memberName(value);
  if (object.type !== AST_NODE_TYPES.Identifier || name === null) return null;
  return memberOf(importOf(object, resolver, seen), name);
}

// The expression a TypeScript wrapper or an optional chain holds, with
// every such layer taken off: `x as T`, `<T>x`, `x satisfies T`, `x!`,
// `x<T>` and the chain around `a?.b` or `a?.()`. None of them changes which
// function a name holds, so the rules read through them.
export function unwrapped(node: TSESTree.Node): TSESTree.Node {
  let current = node;
  for (;;) {
    switch (current.type) {
      case AST_NODE_TYPES.TSAsExpression:
      case AST_NODE_TYPES.TSTypeAssertion:
      case AST_NODE_TYPES.TSSatisfiesExpression:
      case AST_NODE_TYPES.TSNonNullExpression:
      case AST_NODE_TYPES.TSInstantiationExpression:
      case AST_NODE_TYPES.ChainExpression:
        current = current.expression;
        break;
      default:
        return current;
    }
  }
}

// The name a member expression reads: `a.b`, `a["b"]` or a template key
// with nothing interpolated.
export function memberName(node: TSESTree.MemberExpression): string | null {
  return keyName(node.property, node.computed);
}

// The name a key gives, whether it reads a member or an object pattern's
// property: a plain identifier, a string or a template with nothing
// interpolated. A computed identifier is a variable, so it gives none.
function keyName(key: TSESTree.Node, computed: boolean): string | null {
  if (!computed && key.type === AST_NODE_TYPES.Identifier) return key.name;
  if (key.type === AST_NODE_TYPES.TemplateLiteral) {
    return key.expressions.length === 0
      ? (key.quasis[0]?.value.cooked ?? null)
      : null;
  }
  return key.type === AST_NODE_TYPES.Literal && typeof key.value === "string"
    ? key.value
    : null;
}

// What an identifier's binding imports from a relative module: a named
// import, or the whole module (name null) for a namespace import. It
// follows a local alias that is never assigned again, such as
// `const ask = askEuropePmc`, `const ask = owed.askEuropePmc` or
// `const { askEuropePmc: ask } = owed`. Null for any other binding,
// including a destructured name with a default, which may not be the
// import.
export function importOf(
  identifier: TSESTree.Identifier,
  resolver: Resolver,
  seen: ReadonlySet<TSESLint.Scope.Variable> = new Set(),
): { module: string; name: string | null } | null {
  const variable = lookup(
    identifier.name,
    resolver.sourceCode.getScope(identifier),
  );
  if (variable === null || seen.has(variable)) return null;
  const def = variable.defs[0];
  if (def?.type === TSESLint.Scope.DefinitionType.Variable) {
    if (variable.defs.length !== 1) return null;
    // Resolve the alias before scanning for writes, so a local that holds
    // anything else costs no walk over its references.
    const alias = aliasOf(
      def.node,
      def.name,
      resolver,
      new Set([...seen, variable]),
    );
    return alias === null || reassigned(variable) ? null : alias;
  }
  if (def?.parent?.type !== AST_NODE_TYPES.ImportDeclaration) return null;
  const module = moduleOf(def.parent.source.value, resolver);
  if (module === null) return null;
  if (def.node.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
    return { module, name: null };
  }
  if (def.node.type !== AST_NODE_TYPES.ImportSpecifier) return null;
  return { module, name: exportedName(def.node.imported) };
}

// True when anything but its declaration writes to the variable.
function reassigned(variable: TSESLint.Scope.Variable): boolean {
  return variable.references.some((ref) => ref.isWrite() && !ref.init);
}

// What a declarator binds `name` to, when it aliases an import: the whole
// of another identifier, a name read from a namespace import, or a name
// destructured from one at the top of an object pattern. It reads through
// the wrappers unwrapped takes off.
function aliasOf(
  declarator: TSESTree.VariableDeclarator,
  name: TSESTree.Identifier,
  resolver: Resolver,
  seen: ReadonlySet<TSESLint.Scope.Variable>,
): { module: string; name: string | null } | null {
  const { id } = declarator;
  if (declarator.init === null) return null;
  if (id === name) return bindingOf(declarator.init, resolver, seen);
  const init = unwrapped(declarator.init);
  if (
    id.type !== AST_NODE_TYPES.ObjectPattern ||
    init.type !== AST_NODE_TYPES.Identifier
  ) {
    return null;
  }
  const property = id.properties.find(
    (p): p is TSESTree.Property =>
      p.type === AST_NODE_TYPES.Property && p.value === name,
  );
  if (property === undefined) return null;
  return memberOf(
    importOf(init, resolver, seen),
    keyName(property.key, property.computed),
  );
}

// The named import a member of a namespace import gives.
function memberOf(
  binding: { module: string; name: string | null } | null,
  name: string | null,
): { module: string; name: string } | null {
  if (binding?.name !== null || name === null) return null;
  return { module: binding.module, name };
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

// The repo's root: the directory that holds eslint.config.js and this
// folder of rules. Node takes it from the rules' real path.
const root = fileURLToPath(new URL("..", import.meta.url));

// The file's path from the repo's root, with forward slashes, wherever
// ESLint runs. A relative filename is relative to the directory ESLint runs
// in, so it is resolved from there first. ESLint gives the path the editor
// or shell used, which may reach the repo through a symlink (#402). When
// that path falls outside the root, both are compared again as real paths.
// Only then does it read the disk, so a file named from the root costs
// nothing, and the last answer is kept because the rules ask for the same
// file many times.
let last: { filename: string; cwd: string; path: string } | undefined;
export function repoPath(context: { filename: string; cwd: string }): string {
  const { filename, cwd } = context;
  if (last?.filename !== filename || last.cwd !== cwd) {
    const file = resolve(cwd, filename);
    let path = relative(root, file);
    if (path.startsWith("..") || isAbsolute(path)) {
      path = relative(realPath(root), realPath(file));
    }
    last = { filename, cwd, path: path.split(sep).join("/") };
  }
  return last.path;
}

// An absolute path with every symlink resolved. An editor lints a buffer
// that may not be saved yet, so a file or folder that is not on disk keeps
// its name under its parent's real path.
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}
