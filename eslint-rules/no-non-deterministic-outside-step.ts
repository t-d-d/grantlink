import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { TSESLint } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import {
  aliasDeclarator,
  createRule,
  exportedName,
  insideCheckpointedCallback,
  keyName,
  lookup,
  memberName,
  unwrapped,
  walkAliases,
} from "./create-rule.ts";
import type { Resolver } from "./create-rule.ts";

// Ported from podstow's rule of the same name (durable-execution.md).
//
// A durable body runs again from the top on every replay. A clock or random
// read outside a checkpointed callback gives a new value each time, so the
// body can take a different path than the one its checkpoints recorded. A
// child context, parallel and map replay their callbacks, and a step's name
// is evaluated in the body, so none of those count as inside. The rule
// reports at each read and does not follow calls. A call, `Date.now()`,
// reports once, at its callee, and `Date()` and `new Date()` report once,
// at the call. An alias of a method, `const now = Date.now`, reports where
// it is declared, since that reads the method, and again at each call,
// `now()`. A method destructured from its object, `const { now } = Date`,
// reports only at each call. A name with a default, `const { foo: D = Date }
// = x`, is followed to the default when its initial value names no source,
// and reports as an alias does. A pattern that destructures from a source,
// `const { now: { call } } = Date`, or a member that calls `Date`,
// `const { Date: { bind } } = globalThis`, reports once, at that key, or at
// `Date` itself when it is what the pattern destructures, `{ bind } = Date`.
// An alias of `Date` itself, `const D = Date`, reports only where it is
// used, `D()` or `ids.map(D)`, unless it is exported, `export const D =
// Date`. Then it also reports where it is declared, so `D()` in the same
// module gives a second report. A report at an export, which cannot move
// inside a step, says the source passes to another module instead. An
// object that holds a source, such as `Math`, `crypto` or `globalThis`,
// reports where it is passed on, `helper(Math)` or `return crypto`, since
// the code that gets it may read the source unseen.
const NON_DETERMINISTIC: Readonly<Record<string, ReadonlySet<string>>> = {
  Math: new Set(["random"]),
  Date: new Set(["now"]),
  performance: new Set(["now"]),
  crypto: new Set([
    "randomBytes",
    "randomFill",
    "randomFillSync",
    "randomInt",
    "getRandomValues",
    "randomUUID",
  ]),
};

// The global path a module's import stands for: its default or namespace
// import is the module itself, and a named import is a member of it.
const MODULES: Readonly<Record<string, readonly string[]>> = {
  crypto: ["crypto"],
  perf_hooks: ["perf_hooks"],
};

// The names a path may start with that stand for the global object.
const GLOBAL_OBJECT = new Set(["globalThis", "global"]);

// The objects that hold a clock or random source, such as `Math`,
// `crypto`, `perf_hooks` or `globalThis`, as a path of one name.
const HOLDERS: ReadonlySet<string> = new Set([
  ...Object.keys(NON_DETERMINISTIC),
  ...Object.values(MODULES).map((module) => module.join(".")),
  ...GLOBAL_OBJECT,
]);

// A path read the way the code would read it from the globals, such as
// `globalThis.Date`, `perf_hooks.performance` or `crypto.webcrypto`,
// written the way NON_DETERMINISTIC keys it.
function normalised(path: readonly string[]): readonly string[] {
  let rest = path;
  while (rest.length > 1 && GLOBAL_OBJECT.has(rest[0] ?? "")) {
    rest = rest.slice(1);
  }
  if (rest[0] === "perf_hooks" && rest[1] === "performance") {
    rest = rest.slice(1);
  }
  if (rest[0] === "crypto" && rest[1] === "webcrypto") {
    rest = ["crypto", ...rest.slice(2)];
  }
  return rest;
}

// True when a declaration is ambient, `declare const performance: ...` or
// a `var` in `declare global { ... }`: it names a global, not a local.
function ambient(node: TSESTree.Node): boolean {
  for (let n: TSESTree.Node | undefined = node; n; n = n.parent) {
    if (
      (n.type === AST_NODE_TYPES.VariableDeclaration ||
        n.type === AST_NODE_TYPES.TSModuleDeclaration ||
        n.type === AST_NODE_TYPES.ClassDeclaration ||
        n.type === AST_NODE_TYPES.TSDeclareFunction) &&
      n.declare
    ) {
      return true;
    }
  }
  return false;
}

// True when a definition declares a value in place of the global of the
// same name. A type, an interface, an ambient declaration and a type-only
// import declare no value, so a name with only those still reads the
// global.
function declaresValue(def: TSESLint.Scope.Definition): boolean {
  switch (def.type) {
    case TSESLint.Scope.DefinitionType.Type:
    case TSESLint.Scope.DefinitionType.ImplicitGlobalVariable:
      return false;
    case TSESLint.Scope.DefinitionType.ImportBinding:
      return !(
        (def.parent.type === AST_NODE_TYPES.ImportDeclaration &&
          def.parent.importKind === "type") ||
        (def.node.type === AST_NODE_TYPES.ImportSpecifier &&
          def.node.importKind === "type")
      );
    default:
      return !ambient(def.node);
  }
}

// The global path an expression reads, through the wrappers unwrapped takes
// off: a global name, a member of one under any constant key, a local alias
// of either, or an import from a module MODULES names. Null for anything
// else, such as a parameter or a local function. An alias's later write does
// not stop the walk, since a path here only makes the rule refuse.
function pathOf(
  node: TSESTree.Node,
  resolver: Resolver,
  seen: ReadonlySet<TSESLint.Scope.Variable>,
): readonly string[] | null {
  const value = unwrapped(node);
  if (value.type === AST_NODE_TYPES.Identifier) {
    return identifierPath(value, resolver, seen);
  }
  if (value.type !== AST_NODE_TYPES.MemberExpression) return null;
  const name = memberName(value);
  if (name === null) return null;
  const object = pathOf(value.object, resolver, seen);
  return object === null ? null : normalised([...object, name]);
}

function identifierPath(
  identifier: TSESTree.Identifier,
  resolver: Resolver,
  seen: ReadonlySet<TSESLint.Scope.Variable>,
): readonly string[] | null {
  const walk = walkAliases(identifier, resolver);
  if (walk === null) {
    // An implicit global, or a chain that loops back on itself.
    const declared = lookup(
      identifier.name,
      resolver.sourceCode.getScope(identifier),
    );
    return declared === null ? [identifier.name] : null;
  }
  const end = walk.chain.at(-1);
  if (end === undefined || seen.has(end)) return null;
  // A global the scope manager knows, such as one from a lib or a config,
  // or a name the file declares only as a type or ambiently.
  if (!end.defs.some(declaresValue)) return [end.name];
  const next = new Set([...seen, end]);
  const alias = aliasDeclarator(end);
  if (alias !== null) {
    const { declarator, name } = alias;
    if (declarator.init === null) return null;
    const init = pathOf(declarator.init, resolver, next);
    if (declarator.id === name) return init;
    // A name destructured from an object pattern, at its top,
    // `{ now } = Date`, or from a nested pattern,
    // `{ Date: { now } } = globalThis`, with or without a default.
    if (declarator.id.type !== AST_NODE_TYPES.ObjectPattern) return null;
    return destructuredFrom(
      declarator.id,
      init === null ? [] : [init],
      name,
      resolver,
      next,
    );
  }
  const def = end.defs[0];
  if (def?.parent?.type !== AST_NODE_TYPES.ImportDeclaration) return null;
  return modulePath(
    def.parent.source.value,
    def.node.type === AST_NODE_TYPES.ImportSpecifier
      ? exportedName(def.node.imported)
      : null,
  );
}

// Visit each property of an object pattern, down any nested patterns, with
// the global paths it may read. `keys` follows the keys from what the
// pattern destructures, `{ Date: { now } } = globalThis` reading
// `Date.now` at `now`. A nested pattern also reads from its default,
// `{ foo: { random } = Math } = globalThis`, in place of `foo` when that
// is undefined. Given a target, the walk goes down only the nested
// patterns that hold it. A visit that returns true stops the walk.
function eachProperty(
  pattern: TSESTree.ObjectPattern,
  bases: readonly (readonly string[])[],
  resolver: Resolver,
  seen: ReadonlySet<TSESLint.Scope.Variable>,
  visit: (
    property: TSESTree.Property,
    keys: readonly (readonly string[])[],
  ) => boolean,
  target?: TSESTree.Node,
): boolean {
  for (const property of pattern.properties) {
    if (property.type !== AST_NODE_TYPES.Property) continue;
    const key = keyName(property.key, property.computed);
    const keys =
      key === null ? [] : bases.map((base) => normalised([...base, key]));
    if (visit(property, keys)) return true;
    const inner = withoutDefault(property.value);
    if (
      inner.type !== AST_NODE_TYPES.ObjectPattern ||
      (target !== undefined &&
        (target.range[0] < inner.range[0] || target.range[1] > inner.range[1]))
    ) {
      continue;
    }
    const values = [...keys];
    if (property.value.type === AST_NODE_TYPES.AssignmentPattern) {
      const fallback = pathOf(property.value.right, resolver, seen);
      if (fallback !== null) values.push(fallback);
    }
    if (eachProperty(inner, values, resolver, seen, visit, target)) {
      return true;
    }
  }
  return false;
}

// A pattern's target without the default it may give, `{ now = f }`.
function withoutDefault(value: TSESTree.Property["value"]): TSESTree.Node {
  return value.type === AST_NODE_TYPES.AssignmentPattern ? value.left : value;
}

// The global path a name destructured from an object pattern reads, from
// what the pattern destructures or from a default, the name's own,
// `{ foo: M = Math } = globalThis`, or a nested pattern's. Where they
// differ, the first that names a source or an object holding one, `Date`
// among them, wins, then one that starts at such an object, since a path
// here only makes the rule refuse.
// Null when none is known.
function destructuredFrom(
  pattern: TSESTree.ObjectPattern,
  bases: readonly (readonly string[])[],
  name: TSESTree.Identifier,
  resolver: Resolver,
  seen: ReadonlySet<TSESLint.Scope.Variable>,
): readonly string[] | null {
  let found: readonly (readonly string[])[] = [];
  eachProperty(
    pattern,
    bases,
    resolver,
    seen,
    (property, keys) => {
      if (withoutDefault(property.value) !== name) return false;
      // A name's own default, `{ foo: M = Math } = globalThis`, may give it
      // in place of what the pattern reads.
      const fallback =
        property.value.type === AST_NODE_TYPES.AssignmentPattern
          ? pathOf(property.value.right, resolver, seen)
          : null;
      found = fallback === null ? keys : [...keys, fallback];
      return true;
    },
    name,
  );
  return (
    found.find(
      (path) => opOf(path) !== undefined || holderOf(path) !== undefined,
    ) ??
    found.find((path) => HOLDERS.has(path[0] ?? "")) ??
    found[0] ??
    null
  );
}

// True when an object pattern destructures a member that calls what it
// destructures from, `{ bind }`, or one under a key the rule cannot name,
// which may be `call`.
function callsThrough(pattern: TSESTree.ObjectPattern): boolean {
  return pattern.properties.some((property) => {
    if (property.type !== AST_NODE_TYPES.Property) return false;
    const key = keyName(property.key, property.computed);
    return key === null || CALLS_THROUGH.has(key);
  });
}

// The global path a name from a module stands for, or the module itself
// when the name is null or `default`, which a built-in module exports as
// itself. Null for a module MODULES does not name.
function modulePath(
  source: string,
  name: string | null,
): readonly string[] | null {
  const module = MODULES[source.replace(/^node:/, "")];
  if (module === undefined) return null;
  return name === null || name === "default"
    ? module
    : normalised([...module, name]);
}

// The global path `export { name } from "module"` passes on, for a module
// MODULES names. Null for any other specifier, or one that passes on a
// type only.
function reexported(
  specifier: TSESTree.ExportSpecifier,
): readonly string[] | null {
  const declaration = specifier.parent;
  if (
    declaration.source === null ||
    declaration.exportKind === "type" ||
    specifier.exportKind === "type"
  ) {
    return null;
  }
  return modulePath(declaration.source.value, exportedName(specifier.local));
}

// The clock or random source a path names, such as `Date.now`.
function opOf(path: readonly string[] | null): string | undefined {
  if (path?.length !== 2) return undefined;
  const [object = "", property = ""] = path;
  return NON_DETERMINISTIC[object]?.has(property) === true
    ? `${object}.${property}`
    : undefined;
}

// True when a path names `Date` itself, which reads the clock when called.
function namesDate(path: readonly string[] | null): boolean {
  return path?.length === 1 && path[0] === "Date";
}

// The object a path names when it is one of HOLDERS. Another module that
// gets it may read the source from it, `M.random()`, and the rule does not
// follow it there.
function holderOf(path: readonly string[] | null): string | undefined {
  if (path?.length !== 1) return undefined;
  const [name = ""] = path;
  return HOLDERS.has(name) ? name : undefined;
}

// The module `export * from "module"` passes on when MODULES names it,
// written as its global path, such as `crypto`. Undefined for any other
// module, or for `export type * from "module"`, which passes on no value.
function reexportedAll(
  declaration: TSESTree.ExportAllDeclaration,
): string | undefined {
  if (declaration.exportKind === "type") return undefined;
  return holderOf(modulePath(declaration.source.value, null));
}

// True when the identifier is read as a value, rather than declared, used
// as a property's name, named in a type, `x: Date` or `typeof randomUUID`,
// or passed on by an export, `export { randomUUID }`, which
// exportsUnfollowed checks.
function isRead(identifier: TSESTree.Identifier, resolver: Resolver): boolean {
  if (
    identifier.parent.type === AST_NODE_TYPES.TSTypeQuery ||
    identifier.parent.type === AST_NODE_TYPES.ExportSpecifier
  ) {
    return false;
  }
  return resolver.sourceCode
    .getScope(identifier)
    .references.some(
      (ref) =>
        ref.identifier === identifier && ref.isValueReference && ref.isRead(),
    );
}

// The outermost node that only wraps this one in the layers unwrapped
// takes off, such as `(Date.now as F)` or `(0, Date)`.
function outermost(node: TSESTree.Node): TSESTree.Node {
  let outer = node;
  while (outer.parent !== undefined && unwrapped(outer.parent) === node) {
    outer = outer.parent;
  }
  return outer;
}

// True when the node is the function a call calls, read through the
// wrappers unwrapped takes off, so `Date.now!()`, `(Date.now as F)()` and
// `(0, Date.now)()` are each a call.
function calledThrough(node: TSESTree.Node): boolean {
  const outer = outermost(node);
  return (
    outer.parent?.type === AST_NODE_TYPES.CallExpression &&
    outer.parent.callee === outer
  );
}

// The members of `Date` that call it: `Date.call(null)` reads the clock as
// `Date()` does, and `Date.bind(null)` returns a function that does.
const CALLS_THROUGH = new Set(["call", "apply", "bind"]);

// The operators that test `Date` without calling it, `x instanceof Date`
// and `x.constructor === Date`.
const TESTS_ONLY = new Set(["instanceof", "===", "!==", "==", "!="]);

// True when an alias's declaration is exported, `export const D = Date`,
// or the alias is, `export { D }`: another module may call it, and the rule
// does not follow reads there.
function exported(
  declarator: TSESTree.VariableDeclarator,
  variable: TSESLint.Scope.Variable,
): boolean {
  return (
    declarator.parent.parent.type === AST_NODE_TYPES.ExportNamedDeclaration ||
    variable.references.some(
      (ref) => ref.identifier.parent.type === AST_NODE_TYPES.ExportSpecifier,
    )
  );
}

// True when the identifier hands an import or a destructured name to another
// module: the binding in an exported pattern, `export const { now } = Date`,
// or the local of an export, `export { random }`, unless that binding's own
// export already reports. The rule does not follow a relative import, so the
// caller there goes unchecked. A plain alias, `export const D = Date`, is
// left to its initial value when that reports, as a source passed on does,
// and reported at the binding when it does not, as an object that holds a
// source, `export const M = Math`, does not. A type-only export passes on no
// value, and `export { x } from "..."` names another module's binding, which
// reexported checks.
function exportsUnfollowed(
  identifier: TSESTree.Identifier,
  resolver: Resolver,
  initReports: boolean,
): boolean {
  const variable = lookup(
    identifier.name,
    resolver.sourceCode.getScope(identifier),
  );
  if (variable === null) return false;
  const alias = aliasDeclarator(variable);
  const parent = identifier.parent;
  if (parent.type !== AST_NODE_TYPES.ExportSpecifier) {
    return (
      alias?.name === identifier &&
      exportedDeclaration(alias.declarator) &&
      (alias.declarator.id !== alias.name || !initReports)
    );
  }
  const declaration = parent.parent;
  if (
    parent.local !== identifier ||
    parent.exportKind === "type" ||
    declaration.source !== null ||
    declaration.exportKind === "type"
  ) {
    return false;
  }
  return (
    alias === null ||
    ((alias.declarator.id !== alias.name || !initReports) &&
      !exportedDeclaration(alias.declarator))
  );
}

// True when a source read as a value passes to another module: the value
// an export default or an export assignment passes on, `export default
// Date.now`, or the initial value of an alias that is exported, `export const
// now = Date.now`, or `const D = Date` and then `export { D }`. Its report
// stands for the export. So is an object that holds a source when an
// exported pattern copies its rest, `export const { ...m } = Math`. A call is
// never one, since `export const d = new Date()` passes on the value it read
// and not the source.
function exportedSource(node: TSESTree.Node, resolver: Resolver): boolean {
  const outer = outermost(node);
  const parent = outer.parent;
  switch (parent?.type) {
    case AST_NODE_TYPES.ExportDefaultDeclaration:
      return parent.declaration === outer;
    case AST_NODE_TYPES.TSExportAssignment:
      return parent.expression === outer;
    case AST_NODE_TYPES.VariableDeclarator: {
      if (parent.init !== outer) return false;
      if (parent.id.type === AST_NODE_TYPES.ObjectPattern) {
        return copiesRest(parent.id) && exportedDeclaration(parent);
      }
      if (parent.id.type !== AST_NODE_TYPES.Identifier) return false;
      const [declared] = resolver.sourceCode.getDeclaredVariables(parent);
      return declared !== undefined && exported(parent, declared);
    }
    default:
      return false;
  }
}

// True when a declarator sits in an exported declaration,
// `export const { now } = Date` or `export const M = Math`.
function exportedDeclaration(declarator: TSESTree.VariableDeclarator): boolean {
  return (
    declarator.parent.parent.type === AST_NODE_TYPES.ExportNamedDeclaration
  );
}

// True when two paths name the same global, such as a destructured name
// the rule follows to its default, `{ foo: M = Math }`, and that default.
function samePath(
  a: readonly string[] | null,
  b: readonly string[] | null,
): boolean {
  return a !== null && b !== null && a.join(".") === b.join(".");
}

// True when a pattern ends in a rest, `{ a, ...rest }`, which copies the
// object's other members.
function copiesRest(pattern: TSESTree.ObjectPattern): boolean {
  return pattern.properties.some(
    (property) => property.type === AST_NODE_TYPES.RestElement,
  );
}

// True when `Date`, read as a value, goes somewhere that may call it, such
// as `ids.map(Date)` or `Reflect.construct(Date, [])`. Not when the code
// calls or constructs it, which the call checks report with their
// arguments in view, reads a member that does not call it, `Date.UTC(...)`,
// tests it, `x instanceof Date`, `typeof Date`, `"now" in Date`,
// `if (Date)`, `!Date` or `Date && f()`, or declares an alias,
// `const D = Date`, whose own reads the rule follows. A member under a key
// the rule cannot name, `Date[k]`, may be `call`, so it counts.
//
// With `holder` set, it asks the same of an object that holds a source,
// such as `helper(Math)`, `{ m: Math }` or `return crypto`, which the code
// that gets it may read the source from unseen. The rest of a pattern,
// `const { ...rest } = c`, copies its members, so it counts. An export by
// default and an alias whose declaration is exported are left to
// checkDefault and exportsUnfollowed, which report those.
function passedOn(
  node: TSESTree.Node,
  resolver: Resolver,
  holder = false,
): boolean {
  const outer = outermost(node);
  const parent = outer.parent;
  switch (parent?.type) {
    case AST_NODE_TYPES.CallExpression:
    case AST_NODE_TYPES.NewExpression:
      return parent.callee !== outer;
    case AST_NODE_TYPES.MemberExpression: {
      if (parent.object !== outer) return true;
      const name = memberName(parent);
      return name === null || CALLS_THROUGH.has(name);
    }
    case AST_NODE_TYPES.BinaryExpression:
      if (parent.operator === "in") return parent.right !== outer;
      return !(
        TESTS_ONLY.has(parent.operator) &&
        (parent.right === outer || parent.operator !== "instanceof")
      );
    case AST_NODE_TYPES.UnaryExpression:
      return parent.operator !== "typeof" && parent.operator !== "!";
    case AST_NODE_TYPES.IfStatement:
    case AST_NODE_TYPES.ConditionalExpression:
    case AST_NODE_TYPES.WhileStatement:
    case AST_NODE_TYPES.DoWhileStatement:
    case AST_NODE_TYPES.ForStatement:
      return parent.test !== outer;
    // `Date && f()` gives `Date` only when it is falsy.
    case AST_NODE_TYPES.LogicalExpression:
      return !(parent.operator === "&&" && parent.left === outer);
    // A default of a nested pattern in a declaration the rule follows,
    // `const { foo: { bind } = Date } = globalThis`, calls it only through
    // a member the pattern destructures, and a holder passes on only
    // through a rest. A name's own default, `const { foo: D = Date } = x` or
    // `const { foo: M = Math } = x`, reports where the name is used, as an
    // alias does, when the rule follows the name to it. Anywhere else, such
    // as a parameter's default or an assignment, the rule does not follow
    // the names it gives, so it counts as passed on.
    case AST_NODE_TYPES.AssignmentPattern:
      if (parent.right !== outer || !inFollowedDeclaration(parent)) {
        return true;
      }
      return parent.left.type === AST_NODE_TYPES.ObjectPattern
        ? callsThrough(parent.left) || (holder && copiesRest(parent.left))
        : parent.left.type !== AST_NODE_TYPES.Identifier ||
            !samePath(
              pathOf(parent.left, resolver, new Set()),
              pathOf(outer, resolver, new Set()),
            );
    case AST_NODE_TYPES.VariableDeclarator: {
      if (parent.init !== outer) return true;
      if (parent.id.type === AST_NODE_TYPES.ObjectPattern) {
        return callsThrough(parent.id) || (holder && copiesRest(parent.id));
      }
      const [declared, ...more] =
        resolver.sourceCode.getDeclaredVariables(parent);
      return (
        more.length > 0 ||
        declared === undefined ||
        aliasDeclarator(declared) === null ||
        (!holder && exported(parent, declared))
      );
    }
    case AST_NODE_TYPES.ExportDefaultDeclaration:
    case AST_NODE_TYPES.TSExportAssignment:
      return !holder;
    default:
      return true;
  }
}

// True when a nested pattern's default sits in an object pattern that a
// declarator with an initial value declares, `const { foo: { now } = Date }
// = globalThis`, whose names identifierPath follows. Not for a parameter, an
// assignment, or a loop's declarator, which has no initial value.
function inFollowedDeclaration(node: TSESTree.AssignmentPattern): boolean {
  let n: TSESTree.Node = node;
  for (;;) {
    const parent: TSESTree.Node = n.parent;
    if (parent.type !== AST_NODE_TYPES.Property || parent.value !== n) {
      return false;
    }
    const pattern: TSESTree.Node = parent.parent;
    if (pattern.type !== AST_NODE_TYPES.ObjectPattern) return false;
    const above: TSESTree.Node = pattern.parent;
    if (above.type === AST_NODE_TYPES.VariableDeclarator) {
      return above.id === pattern && above.init !== null;
    }
    n =
      above.type === AST_NODE_TYPES.AssignmentPattern && above.left === pattern
        ? above
        : pattern;
  }
}

export const noNonDeterministicOutsideStep = createRule({
  name: "no-non-deterministic-outside-step",
  meta: {
    type: "problem",
    docs: {
      description:
        "A clock or random read in a durable body must sit inside a step.",
    },
    schema: [],
    messages: {
      nonDeterministicOutsideStep:
        "`{{op}}` is outside every step, so a replay reads a new value. Move it inside `ctx.step(...)`, or add `// eslint-disable-next-line grantlink/no-non-deterministic-outside-step -- <why it is safe>`.",
      // An export cannot move inside a step, so its report says how to
      // stop passing the source on.
      exportedOutsideStep:
        "`{{op}}` passes to another module, which may read it outside every step where this rule cannot see. Export a function that takes the value from a step instead, or add `// eslint-disable-next-line grantlink/no-non-deterministic-outside-step -- <why it is safe>`.",
    },
  },
  defaultOptions: [],
  create(context) {
    // A report at an export says the source passes to another module, since
    // an export cannot move inside a step.
    const report = (
      node: TSESTree.Node,
      op: string,
      atExport: boolean,
    ): void => {
      if (insideCheckpointedCallback(node, context)) return;
      context.report({
        node,
        messageId: atExport
          ? "exportedOutsideStep"
          : "nonDeterministicOutsideStep",
        data: { op },
      });
    };
    // A call reports through its callee, so `Date.now()` and a bare
    // `Math.random` passed as a value each report once.
    const check = (node: TSESTree.Node, path: readonly string[] | null) => {
      const op = opOf(path);
      if (op === undefined) return;
      if (calledThrough(node)) report(node, `${op}()`, false);
      else report(node, op, exportedSource(node, context));
    };
    const isDate = (callee: TSESTree.Node): boolean =>
      namesDate(pathOf(callee, context, new Set()));
    // An object that holds a source, exported by default, `export default
    // Math` or `export = c`. `Date` reports as a value passed on, and an
    // alias whose own declaration is exported reports there.
    const checkDefault = (value: TSESTree.Node): void => {
      const path = pathOf(value, context, new Set());
      const holder = holderOf(path);
      if (holder === undefined || namesDate(path)) return;
      const inner = unwrapped(value);
      if (inner.type === AST_NODE_TYPES.Identifier) {
        const variable = lookup(inner.name, context.sourceCode.getScope(inner));
        const alias = variable === null ? null : aliasDeclarator(variable);
        if (alias !== null && exportedDeclaration(alias.declarator)) return;
      }
      report(value, holder, true);
    };
    // `Date`, or an object that holds a source, read as a value and passed
    // on, such as `ids.map(Date)`, `helper(Math)` or
    // `{ c: globalThis.crypto }`.
    const checkPassed = (
      node: TSESTree.Node,
      path: readonly string[] | null,
    ) => {
      const date = namesDate(path);
      const passed = date ? "Date" : holderOf(path);
      if (passed !== undefined && passedOn(node, context, !date)) {
        report(node, passed, exportedSource(node, context));
      }
    };
    return {
      NewExpression(node) {
        if (node.arguments.length === 0 && isDate(node.callee)) {
          report(node, "new Date()", false);
        }
      },
      // `Date()` without `new` returns the current time as a string, so it
      // reads the clock as `new Date()` does, with or without arguments.
      CallExpression(node) {
        if (isDate(node.callee)) report(node, "Date()", false);
      },
      MemberExpression(node) {
        const path = pathOf(node, context, new Set());
        check(node, path);
        checkPassed(node, path);
      },
      // A name passed on from a module that holds a clock or random source,
      // `export { randomUUID } from "node:crypto"`, or an object that holds
      // one, `export { webcrypto } from "node:crypto"`.
      ExportSpecifier(node) {
        const path = reexported(node);
        const op = opOf(path) ?? holderOf(path);
        if (op !== undefined) report(node.local, op, true);
      },
      // Every name of such a module, `export * from "node:crypto"`.
      ExportAllDeclaration(node) {
        const op = reexportedAll(node);
        if (op !== undefined) report(node, op, true);
      },
      ExportDefaultDeclaration(node) {
        checkDefault(node.declaration);
      },
      TSExportAssignment(node) {
        checkDefault(node.expression);
      },
      // A pattern that reads a source to destructure from it, `const {
      // now: { call } } = Date`, reports at that key, since the name it
      // declares reads no source itself. So does one that destructures a
      // member that calls `Date` from it, `{ Date: { bind } } = globalThis`.
      // Destructuring that member straight from `Date`, or from a default
      // `Date`, reports at `Date`, as passedOn says.
      VariableDeclarator(node) {
        if (node.id.type !== AST_NODE_TYPES.ObjectPattern) return;
        const init =
          node.init === null ? null : pathOf(node.init, context, new Set());
        eachProperty(
          node.id,
          init === null ? [] : [init],
          context,
          new Set(),
          (property, keys) => {
            const inner = withoutDefault(property.value);
            if (inner.type !== AST_NODE_TYPES.ObjectPattern) return false;
            const op = keys.map(opOf).find((found) => found !== undefined);
            if (op !== undefined) {
              report(property.key, op, false);
            } else if (keys.some(namesDate) && callsThrough(inner)) {
              report(property.key, "Date", false);
            }
            return false;
          },
        );
      },
      // A named import, or an alias of a member, read on its own, such as
      // `randomUUID()` after `import { randomUUID } from "node:crypto"`, or one
      // exported for another module to read.
      Identifier(node) {
        const path = pathOf(node, context, new Set());
        const op = opOf(path) ?? (namesDate(path) ? "Date" : undefined);
        const passed = op ?? holderOf(path);
        if (passed === undefined) return;
        if (exportsUnfollowed(node, context, op !== undefined)) {
          report(node, passed, true);
          return;
        }
        if (!isRead(node, context)) return;
        check(node, path);
        checkPassed(node, path);
      },
    };
  },
});
