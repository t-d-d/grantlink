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

// A method call `<receiver>.<name>(...)` whose name is in the set, read
// through the wrappers unwrapped takes off, on the call and on its callee:
// `ctx?.step(...)`, `ctx.step!(...)`, `(ctx.step as F)(...)` and
// `(ctx.step(...) as Promise<T>)` are all a step. It gives the member its
// callee reads, or null for anything else.
export function methodCallIn(
  node: TSESTree.Node,
  names: ReadonlySet<string>,
): TSESTree.MemberExpression | null {
  const call = unwrapped(node);
  if (call.type !== AST_NODE_TYPES.CallExpression) return null;
  const callee = unwrapped(call.callee);
  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    callee.property.type !== AST_NODE_TYPES.Identifier ||
    !names.has(callee.property.name)
  ) {
    return null;
  }
  return callee;
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

// Which alias walks may reach a step helper: only an exact one, or any,
// under the alias policy at AliasWalk.
export type HelperWalk = "exact" | "any";

// The step helper a call calls, if its callee resolves to one: a named
// import `<name>(...)`, or a namespace import `<ns>.<name>(...)` or
// `<ns>["<name>"](...)`, either one reached through an exact walk of local
// aliases (walkAliases), since the helper's callbacks get a step's
// allowances. A rule that refuses what a call may run, such as
// no-nested-durable-operations, passes `walk: "any"` to take an inexact
// walk too. It looks through type assertions, non-null assertions, type
// arguments, optional chaining and the comma operator (unwrapped), on the
// call, the callee and the namespace alike. A local function, an import
// from another module or a computed key that is not a constant string is
// not one. A re-export would hide the helper's module, so
// no-step-helper-re-export refuses one.
export function stepHelperOf(
  node: TSESTree.Node,
  resolver: Resolver,
  walk: HelperWalk = "exact",
): StepHelper | null {
  const call = unwrapped(node);
  if (call.type !== AST_NODE_TYPES.CallExpression) return null;
  const binding = bindingOf(call.callee, resolver);
  if (typeof binding?.name !== "string") return null;
  if (walk === "exact" && !binding.exact) return null;
  return helperNamed(binding.module, binding.name);
}

// What an expression reads from a relative module, through the wrappers
// unwrapped takes off: an identifier's import (importOf), or a name read
// from a namespace import `<ns>.<name>` or `<ns>["<name>"]`. Null for
// anything else. `once` says the expression is read once, as an alias's
// initial value, which importOf passes on.
export function bindingOf(
  node: TSESTree.Node,
  resolver: Resolver,
  seen: ReadonlySet<TSESLint.Scope.Variable> = new Set(),
  once = false,
): ImportBinding | null {
  const value = unwrapped(node);
  if (value.type === AST_NODE_TYPES.Identifier) {
    return importOf(value, resolver, seen, once);
  }
  if (value.type !== AST_NODE_TYPES.MemberExpression) return null;
  const object = unwrapped(value.object);
  const name = memberName(value);
  if (object.type !== AST_NODE_TYPES.Identifier || name === null) return null;
  return memberOf(importOf(object, resolver, seen, once), name);
}

// The expression a TypeScript wrapper, an optional chain or the comma
// operator holds, with every such layer taken off: `x as T`, `<T>x`,
// `x satisfies T`, `x!`, `x<T>`, the chain around `a?.b` or `a?.()`, and
// the last expression of `(a, x)`. None of them changes which function a
// name holds, so the rules read through them.
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
      case AST_NODE_TYPES.SequenceExpression: {
        const last = current.expressions.at(-1);
        if (last === undefined) return current;
        current = last;
        break;
      }
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

// The alias policy every rule follows. A local is an alias of the value it
// is declared with when it has exactly one declaration, a const, let or var
// declarator with an initialiser; a let or var counts as a const does. A
// local declared more than once (`var ask = a; var ask = b;`), or declared
// with no value and given one later (`let ask; ask = a;`), is not an alias,
// and the walk ends at it. A later write does not end the walk, but makes it
// inexact: the local may hold something else when it is read. A local read
// once, as the next alias's initial value, holds what it held at that read,
// so a write that can only run after the read does not count against it
// (writtenBeforeRead, #437).
//
// Where what a name holds lets code off a check, only an exact walk counts:
// stepHelperOf by default, since it gives a step helper's callbacks a step's
// allowances, and no-step-helper-re-export when it lets a module export its
// own helper. Where it only makes a rule refuse, an inexact walk counts too:
// no-step-helper-re-export's refusals, no-nested-durable-operations, for
// a context and for a step helper (stepHelperOf with `walk: "any"`),
// no-closure-in-durable-operations, for a step helper's callbacks
// (isStepHelperCallback with `walk: "any"`), and
// no-non-deterministic-outside-step, for a clock or random source.
export interface AliasWalk {
  // The local the identifier names, then each local it aliases in turn.
  // The last is where the walk ended.
  chain: readonly TSESLint.Scope.Variable[];
  // True when no local along the chain may be written before it is read.
  // The first is read where the identifier sits only when the walk was
  // asked with `once`; otherwise any write to it counts.
  readonly exact: boolean;
}

// Walk the chain of plain aliases from an identifier, such as
// `const ask = askEuropePmc` or `let same = ctx`. It ends at a local that
// aliases a name it cannot resolve. Null when the identifier itself does not
// resolve, or the chain loops back on itself. `once` says the identifier
// itself is read once, as another alias's initial value.
export function walkAliases(
  identifier: TSESTree.Identifier,
  resolver: Resolver,
  once = false,
): AliasWalk | null {
  const first = lookup(
    identifier.name,
    resolver.sourceCode.getScope(identifier),
  );
  if (first === null) return null;
  const chain = [first];
  // The identifier each local in the chain is read through.
  const reads = [identifier];
  for (let current = first; ;) {
    const alias = aliasDeclarator(current);
    const init =
      alias?.declarator.init == null
        ? undefined
        : unwrapped(alias.declarator.init);
    if (
      alias?.declarator.id !== alias?.name ||
      init?.type !== AST_NODE_TYPES.Identifier
    ) {
      break;
    }
    const next = lookup(init.name, resolver.sourceCode.getScope(init));
    if (next === null) break;
    if (chain.includes(next)) return null;
    chain.push(next);
    reads.push(init);
    current = next;
  }
  return {
    chain,
    // Scanning every reference costs a walk, so only a rule that asks pays.
    get exact() {
      return !chain.some((variable, i) =>
        i === 0 && !once
          ? reassigned(variable)
          : writtenBeforeRead(variable, reads[i] ?? identifier),
      );
    },
  };
}

// The declarator a local is an alias through, under the policy above, and
// the name it declares there.
export function aliasDeclarator(variable: TSESLint.Scope.Variable): {
  declarator: TSESTree.VariableDeclarator;
  name: TSESTree.Identifier;
} | null {
  const [def, ...more] = variable.defs;
  if (
    def?.type !== TSESLint.Scope.DefinitionType.Variable ||
    more.length > 0 ||
    def.node.init === null
  ) {
    return null;
  }
  return { declarator: def.node, name: def.name };
}

// What an import binding gives: a named import, or the whole module (name
// null) for a namespace import. Exact as the walk that reached it is.
export interface ImportBinding {
  module: string;
  name: string | null;
  exact: boolean;
}

// What an identifier's binding imports from a relative module, reached
// through any chain of aliases (walkAliases), such as `const ask =
// askEuropePmc`, `const ask = owed.askEuropePmc` or
// `const { askEuropePmc: ask } = owed`. Null for any other binding,
// including a destructured name with a default, which may not be the
// import.
export function importOf(
  identifier: TSESTree.Identifier,
  resolver: Resolver,
  seen: ReadonlySet<TSESLint.Scope.Variable> = new Set(),
  once = false,
): ImportBinding | null {
  const walk = walkAliases(identifier, resolver, once);
  const end = walk?.chain.at(-1);
  if (walk === null || end === undefined || seen.has(end)) return null;
  const declared = aliasDeclarator(end);
  if (declared !== null) {
    // Resolve the alias before scanning for writes, so a local that holds
    // anything else costs no walk over its references.
    const alias = aliasOf(
      declared.declarator,
      declared.name,
      resolver,
      new Set([...seen, end]),
    );
    return alias === null
      ? null
      : { ...alias, exact: alias.exact && walk.exact };
  }
  const def = end.defs[0];
  if (def?.parent?.type !== AST_NODE_TYPES.ImportDeclaration) return null;
  const module = moduleOf(def.parent.source.value, resolver);
  if (module === null) return null;
  if (def.node.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
    return { module, name: null, exact: walk.exact };
  }
  if (def.node.type !== AST_NODE_TYPES.ImportSpecifier) return null;
  return {
    module,
    name: exportedName(def.node.imported),
    exact: walk.exact,
  };
}

// The references that write to the variable, other than its declaration.
function writesOf(
  variable: TSESLint.Scope.Variable,
): TSESLint.Scope.Reference[] {
  return variable.references.filter((ref) => ref.isWrite() && !ref.init);
}

// True when anything but its declaration writes to the variable.
function reassigned(variable: TSESLint.Scope.Variable): boolean {
  return writesOf(variable).length > 0;
}

// True when a write other than its declaration may run before this read of
// the variable. A variable nothing writes again holds its first value
// wherever it is read. Otherwise it counts none only when the variable is
// an alias under the policy above, every such write follows the read in the
// same function that declares the variable, and no loop around the read may
// reach it without running the declaration first. A write in a nested
// function may run at any time, a read in a function the variable outlives
// may run after any write, and a loop runs a later write before its next
// read.
function writtenBeforeRead(
  variable: TSESLint.Scope.Variable,
  identifier: TSESTree.Identifier,
): boolean {
  const writes = writesOf(variable);
  if (writes.length === 0) return false;
  const declared = aliasDeclarator(variable);
  const read = variable.references.find((ref) => ref.identifier === identifier);
  const scope = variable.scope.variableScope;
  if (declared === null || read?.from.variableScope !== scope) return true;
  return (
    writes.some(
      (ref) =>
        ref.from.variableScope !== scope ||
        ref.identifier.range[0] < identifier.range[1],
    ) || inLoopWithout(identifier, declared.declarator, scope.block)
  );
}

// True when a loop around the node, inside the function or program that
// declares the variable, may reach it without running the declarator first
// on that pass: the declarator is not in the loop's body, or it declares a
// var, which a pass may skip or run after the read and which keeps its
// value from the pass before. A loop outside that function calls it afresh
// on each pass, with a fresh var.
function inLoopWithout(
  node: TSESTree.Node,
  declarator: TSESTree.VariableDeclarator,
  boundary: TSESTree.Node,
): boolean {
  const scoped = declarator.parent.kind !== "var";
  // ESLint gives the program a null parent, so the walk stops on either.
  for (let n = node.parent; n && n !== boundary; n = n.parent) {
    switch (n.type) {
      case AST_NODE_TYPES.ForStatement:
      case AST_NODE_TYPES.ForInStatement:
      case AST_NODE_TYPES.ForOfStatement:
      case AST_NODE_TYPES.WhileStatement:
      case AST_NODE_TYPES.DoWhileStatement:
        if (!scoped || !within(declarator, n.body)) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

// True when the node lies inside the other's source range.
function within(node: TSESTree.Node, outer: TSESTree.Node): boolean {
  return node.range[0] >= outer.range[0] && node.range[1] <= outer.range[1];
}

// What a declarator binds `name` to, when it aliases an import through more
// than a plain identifier, which walkAliases follows: a name read from a
// namespace import, or a name destructured from one at the top of an object
// pattern. It reads through the wrappers unwrapped takes off.
function aliasOf(
  declarator: TSESTree.VariableDeclarator,
  name: TSESTree.Identifier,
  resolver: Resolver,
  seen: ReadonlySet<TSESLint.Scope.Variable>,
): ImportBinding | null {
  const { id } = declarator;
  if (declarator.init === null) return null;
  if (id === name) return bindingOf(declarator.init, resolver, seen, true);
  const init = unwrapped(declarator.init);
  if (
    id.type !== AST_NODE_TYPES.ObjectPattern ||
    init.type !== AST_NODE_TYPES.Identifier
  ) {
    return null;
  }
  const key = destructuredKey(id, name, "exact");
  if (key === null) return null;
  return memberOf(importOf(init, resolver, seen, true), key);
}

// The constant key an object pattern destructures `name` from, at its top
// level: `{ now }` or `{ now: at }`. A name with a default, `{ now = f }`,
// may not hold what it reads, so only `with-default` counts it, for a rule
// that only refuses. Null for a computed key that is not a constant.
export function destructuredKey(
  pattern: TSESTree.ObjectPattern,
  name: TSESTree.Identifier,
  defaults: "exact" | "with-default",
): string | null {
  const property = pattern.properties.find(
    (p): p is TSESTree.Property =>
      p.type === AST_NODE_TYPES.Property &&
      (p.value === name ||
        (defaults === "with-default" &&
          p.value.type === AST_NODE_TYPES.AssignmentPattern &&
          p.value.left === name)),
  );
  return property === undefined
    ? null
    : keyName(property.key, property.computed);
}

// The named import a member of a namespace import gives.
function memberOf(
  binding: ImportBinding | null,
  name: string | null,
): ImportBinding | null {
  if (binding?.name !== null || name === null) return null;
  return { ...binding, name };
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

// True when `fn` is an argument a step helper runs inside its step, read
// through the wrappers unwrapped takes off, as in `(async () => {...}) as F`.
// `walk` is passed to stepHelperOf: a rule that only refuses more for
// knowing the helper, such as no-closure-in-durable-operations, passes
// "any" (#518).
export function isStepHelperCallback(
  call: TSESTree.Node,
  fn: TSESTree.Node,
  resolver: Resolver,
  walk: HelperWalk = "exact",
): boolean {
  if (call.type !== AST_NODE_TYPES.CallExpression) return false;
  const helper = stepHelperOf(call, resolver, walk);
  const callback = unwrapped(fn);
  return (
    helper?.callbacks.some((at) => {
      const argument = call.arguments[at];
      return argument !== undefined && unwrapped(argument) === callback;
    }) ?? false
  );
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
    if (
      fn.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
      fn.type !== AST_NODE_TYPES.FunctionExpression
    ) {
      return false;
    }
    const at = outermostWrapper(ancestors, i);
    const argument = ancestors[at];
    const call = ancestors[at - 1];
    return (
      argument !== undefined &&
      call?.type === AST_NODE_TYPES.CallExpression &&
      ((methodCallIn(call, CHECKPOINTS_CALLBACK) !== null &&
        call.arguments.some((arg) => arg === argument)) ||
        isStepHelperCallback(call, argument, resolver))
    );
  });
}

// The index of the outermost ancestor that only wraps ancestors[at] in the
// layers unwrapped takes off, such as `(async () => {...}) as F`, or `at`
// itself when nothing wraps it. The ancestors run from the root down.
export function outermostWrapper(
  ancestors: readonly TSESTree.Node[],
  at: number,
): number {
  const inner = ancestors[at];
  let outer = at;
  for (
    let parent = ancestors[outer - 1];
    parent !== undefined && unwrapped(parent) === inner;
    parent = ancestors[outer - 1]
  ) {
    outer -= 1;
  }
  return outer;
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
