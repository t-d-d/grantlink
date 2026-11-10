import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { TSESLint } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import {
  aliasDeclarator,
  createRule,
  destructuredKey,
  exportedName,
  insideCheckpointedCallback,
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
// declared, so `D()` in the same module gives a second report.
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
    if (declarator.id === name || init === null) return init;
    // A name destructured at the top of an object pattern, `{ now } = Date`,
    // with or without a default.
    if (declarator.id.type !== AST_NODE_TYPES.ObjectPattern) return null;
    const key = destructuredKey(declarator.id, name, "with-default");
    return key === null ? null : normalised([...init, key]);
  }
  const def = end.defs[0];
  if (def?.parent?.type !== AST_NODE_TYPES.ImportDeclaration) return null;
  const module = MODULES[def.parent.source.value.replace(/^node:/, "")];
  if (module === undefined) return null;
  if (def.node.type === AST_NODE_TYPES.ImportSpecifier) {
    return normalised([...module, exportedName(def.node.imported)]);
  }
  return module;
}

// The clock or random source a path names, such as `Date.now`.
function opOf(path: readonly string[] | null): string | undefined {
  if (path?.length !== 2) return undefined;
  const [object = "", property = ""] = path;
  return NON_DETERMINISTIC[object]?.has(property) === true
    ? `${object}.${property}`
    : undefined;
}

// True when the identifier is read as a value, rather than declared, used
// as a property's name, named in a type, `x: Date` or `typeof randomUUID`,
// or passed on by an export, `export { randomUUID }`.
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
    },
  },
  defaultOptions: [],
  create(context) {
    const report = (node: TSESTree.Node, op: string): void => {
      if (insideCheckpointedCallback(node, context)) return;
      context.report({
        node,
        messageId: "nonDeterministicOutsideStep",
        data: { op },
      });
    };
    // A call reports through its callee, so `Date.now()` and a bare
    // `Math.random` passed as a value each report once.
    const check = (node: TSESTree.Node, path: readonly string[] | null) => {
      const op = opOf(path);
      if (op === undefined) return;
      report(node, calledThrough(node) ? `${op}()` : op);
    };
    const namesDate = (path: readonly string[] | null): boolean =>
      path?.length === 1 && path[0] === "Date";
    const isDate = (callee: TSESTree.Node): boolean =>
      namesDate(pathOf(callee, context, new Set()));
    // `Date` read as a value and passed on, such as `ids.map(Date)`.
    const checkDate = (node: TSESTree.Node, path: readonly string[] | null) => {
      if (namesDate(path) && passedOn(node, context)) report(node, "Date");
    };
    return {
      NewExpression(node) {
        if (node.arguments.length === 0 && isDate(node.callee)) {
          report(node, "new Date()");
        }
      },
      // `Date()` without `new` returns the current time as a string, so it
      // reads the clock as `new Date()` does, with or without arguments.
      CallExpression(node) {
        if (isDate(node.callee)) report(node, "Date()");
      },
      MemberExpression(node) {
        const path = pathOf(node, context, new Set());
        check(node, path);
        checkDate(node, path);
      },
      // A named import, or an alias of a member, read on its own, such as
      // `randomUUID()` after `import { randomUUID } from "node:crypto"`.
      Identifier(node) {
        const path = pathOf(node, context, new Set());
        if (opOf(path) === undefined && !namesDate(path)) return;
        if (!isRead(node, context)) return;
        check(node, path);
        checkDate(node, path);
      },
    };
  },
});
