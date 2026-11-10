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
// reports only at each call. An alias of `Date` itself, `const D = Date`,
// reports only where it is used, `D()` or `ids.map(D)`, unless it is
// exported, `export const D = Date`. Then it also reports where it is
// declared, so `D()` in the same module gives a second report. A name with a
// default, `const { foo: D = Date } = x`, is followed to the default when the
// default names a source, or an object that holds one, and its initial value
// does not, and reports as an alias does. A report at
// an export, which cannot move inside a step, says the source passes to
// another module instead.
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
    if (declarator.id === name) return pathOf(declarator.init, resolver, next);
    // A name destructured from an object pattern, at its top,
    // `{ now } = Date`, or from a nested pattern,
    // `{ Date: { now } } = globalThis`, or from a default along the way,
    // `{ foo: M = Math } = globalThis`.
    return followed(sourcesOf(declarator, name, resolver, next))?.path ?? null;
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

// A value a destructured name may hold: the declarator's initial value, or a
// default along the pattern, each with the global path it gives that name.
interface Source {
  readonly node: TSESTree.Node;
  readonly path: readonly string[] | null;
}

// The values a name in a declarator's object pattern may hold, outermost
// first: `const { foo: { random: r } = Math } = globalThis` gives
// `globalThis.foo.random`, then `Math.random`. Null when the name sits under
// a key that is not a constant, or in an array pattern, or the declarator
// has no initial value. `target` is the name, or the left of a default.
function sourcesOf(
  declarator: TSESTree.VariableDeclarator,
  target: TSESTree.Node,
  resolver: Resolver,
  seen: ReadonlySet<TSESLint.Scope.Variable>,
): readonly Source[] | null {
  if (declarator.init === null) return null;
  // The keys and defaults from the target up to the declarator's pattern.
  const steps: (string | TSESTree.Node)[] = [];
  for (let node = target; node !== declarator.id;) {
    const parent = node.parent;
    if (
      parent?.type === AST_NODE_TYPES.AssignmentPattern &&
      parent.left === node
    ) {
      steps.push(parent.right);
      node = parent;
    } else if (
      parent?.type === AST_NODE_TYPES.Property &&
      parent.value === node &&
      parent.parent.type === AST_NODE_TYPES.ObjectPattern
    ) {
      const key = keyName(parent.key, parent.computed);
      if (key === null) return null;
      steps.push(key);
      node = parent.parent;
    } else {
      return null;
    }
  }
  const found: { node: TSESTree.Node; keys: string[] }[] = [
    { node: declarator.init, keys: [] },
  ];
  for (const step of steps.reverse()) {
    if (typeof step === "string") {
      for (const source of found) source.keys.push(step);
    } else {
      found.push({ node: step, keys: [] });
    }
  }
  return found.map(({ node, keys }) => {
    const path = pathOf(node, resolver, seen);
    return {
      node,
      path: path === null ? null : normalised([...path, ...keys]),
    };
  });
}

// The value the rule follows a destructured name to: the first that names a
// clock or random source, `Date` or an object holding one, such as the
// default in `const { foo: M = Math } = Date`, then the first that starts at
// such an object, or else the initial value. A name with a default may hold
// either, and a path here only makes the rule refuse, so the rule follows
// the one that may read a source.
function followed(sources: readonly Source[] | null): Source | null {
  if (sources === null) return null;
  return (
    sources.find(
      ({ path }) => opOf(path) !== undefined || holderOf(path) !== undefined,
    ) ??
    sources.find(({ path }) => HOLDERS.has(path?.[0] ?? "")) ??
    sources[0] ??
    null
  );
}

// True when the rule follows a default to the names it binds,
// `const { foo: D = Date } = x`, so each read of `D` reports, and the
// default itself is not a value passed on. Not for a parameter's default or
// a loop's pattern, whose names the rule does not follow.
function defaultFollowed(
  assignment: TSESTree.AssignmentPattern,
  resolver: Resolver,
): boolean {
  let node: TSESTree.Node = assignment;
  let declarator: TSESTree.Node = assignment.parent;
  while (
    declarator.type === AST_NODE_TYPES.AssignmentPattern ||
    declarator.type === AST_NODE_TYPES.Property ||
    declarator.type === AST_NODE_TYPES.ObjectPattern
  ) {
    node = declarator;
    declarator = declarator.parent;
  }
  if (
    declarator.type !== AST_NODE_TYPES.VariableDeclarator ||
    declarator.id !== node
  ) {
    return false;
  }
  const sources = sourcesOf(declarator, assignment.left, resolver, new Set());
  return sources !== null && followed(sources)?.node === assignment.right;
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
// stands for the export. A call is never one, since `export const d = new
// Date()` passes on the value it read and not the source.
function exportedSource(node: TSESTree.Node, resolver: Resolver): boolean {
  const outer = outermost(node);
  const parent = outer.parent;
  switch (parent?.type) {
    case AST_NODE_TYPES.ExportDefaultDeclaration:
      return parent.declaration === outer;
    case AST_NODE_TYPES.TSExportAssignment:
      return parent.expression === outer;
    case AST_NODE_TYPES.VariableDeclarator: {
      if (
        parent.init !== outer ||
        parent.id.type !== AST_NODE_TYPES.Identifier
      ) {
        return false;
      }
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

// True when `Date`, read as a value, goes somewhere that may call it, such
// as `ids.map(Date)` or `Reflect.construct(Date, [])`. Not when the code
// calls or constructs it, which the call checks report with their
// arguments in view, reads a member that does not call it, `Date.UTC(...)`,
// tests `x instanceof Date` or `typeof Date`, or declares an alias,
// `const D = Date`, whose own reads the rule follows. A member under a key
// the rule cannot name, `Date[k]`, may be `call`, so it counts.
function passedOn(node: TSESTree.Node, resolver: Resolver): boolean {
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
      return !(
        TESTS_ONLY.has(parent.operator) &&
        (parent.right === outer || parent.operator !== "instanceof")
      );
    case AST_NODE_TYPES.UnaryExpression:
      return parent.operator !== "typeof";
    case AST_NODE_TYPES.AssignmentPattern:
      return parent.right !== outer || !defaultFollowed(parent, resolver);
    case AST_NODE_TYPES.VariableDeclarator: {
      if (parent.init !== outer) return true;
      if (parent.id.type === AST_NODE_TYPES.ObjectPattern) return false;
      const [declared, ...more] =
        resolver.sourceCode.getDeclaredVariables(parent);
      return (
        more.length > 0 ||
        declared === undefined ||
        aliasDeclarator(declared) === null ||
        exported(parent, declared)
      );
    }
    default:
      return true;
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
    const namesDate = (path: readonly string[] | null): boolean =>
      path?.length === 1 && path[0] === "Date";
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
    // `Date` read as a value and passed on, such as `ids.map(Date)`.
    const checkDate = (node: TSESTree.Node, path: readonly string[] | null) => {
      if (namesDate(path) && passedOn(node, context)) {
        report(node, "Date", exportedSource(node, context));
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
        checkDate(node, path);
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
        if (op === undefined) return;
        if (!isRead(node, context)) return;
        check(node, path);
        checkDate(node, path);
      },
    };
  },
});
