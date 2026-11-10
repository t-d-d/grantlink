import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { TSESLint } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import {
  createRule,
  insideCheckpointedCallback,
  lookup,
  unwrapped,
} from "./create-rule.ts";

// Ported from podstow's rule of the same name (durable-execution.md).
//
// A durable body runs again from the top on every replay. A clock or random
// read outside a checkpointed callback gives a new value each time, so the
// body can take a different path than the one its checkpoints recorded. A
// child context, parallel and map replay their callbacks, and a step's name
// is evaluated in the body, so none of those count as inside. The rule
// reports at the read itself, once, and does not follow calls.
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

// The read a member names, such as `Date.now`, and the identifier it reads
// it from.
function memberOp(
  node: TSESTree.MemberExpression,
): { op: string; object: TSESTree.Identifier } | undefined {
  if (node.computed) return undefined;
  if (node.object.type !== AST_NODE_TYPES.Identifier) return undefined;
  if (node.property.type !== AST_NODE_TYPES.Identifier) return undefined;
  const allowed = NON_DETERMINISTIC[node.object.name];
  return allowed?.has(node.property.name) === true
    ? {
        op: `${node.object.name}.${node.property.name}`,
        object: node.object,
      }
    : undefined;
}

// The Node modules that export the same reads under the global's name, so
// `import crypto from "node:crypto"` or `import { performance } from
// "node:perf_hooks"` binds the source the rule refuses, not a stand-in.
const SAME_SOURCE: Readonly<Record<string, ReadonlySet<string>>> = {
  crypto: new Set(["crypto", "node:crypto"]),
  performance: new Set(["perf_hooks", "node:perf_hooks"]),
};

// True when the identifier names a value the file declares in place of the
// global, such as a parameter or a class called `Math`. A global the config
// declares has no definition in the file. A type, an interface, an ambient
// `declare` and a type-only import declare no value, and an import from a
// module in SAME_SOURCE is the same source, so none of them shadows it.
function declaredLocally(
  identifier: TSESTree.Identifier,
  sourceCode: Readonly<TSESLint.SourceCode>,
): boolean {
  const variable = lookup(identifier.name, sourceCode.getScope(identifier));
  return variable?.defs.some((def) => shadows(identifier.name, def)) ?? false;
}

function shadows(name: string, def: TSESLint.Scope.Definition): boolean {
  switch (def.type) {
    case TSESLint.Scope.DefinitionType.Type:
    case TSESLint.Scope.DefinitionType.ImplicitGlobalVariable:
      return false;
    case TSESLint.Scope.DefinitionType.ImportBinding: {
      const declaration = def.parent;
      if (declaration.type !== AST_NODE_TYPES.ImportDeclaration) return true;
      if (declaration.importKind === "type") return false;
      if (
        def.node.type === AST_NODE_TYPES.ImportSpecifier &&
        def.node.importKind === "type"
      ) {
        return false;
      }
      return !(SAME_SOURCE[name]?.has(declaration.source.value) ?? false);
    }
    case TSESLint.Scope.DefinitionType.Variable:
      return !def.parent.declare;
    case TSESLint.Scope.DefinitionType.ClassName:
    case TSESLint.Scope.DefinitionType.FunctionName:
    case TSESLint.Scope.DefinitionType.TSModuleName:
      return !("declare" in def.node && def.node.declare);
    default:
      return true;
  }
}

// True when the node is the function a call calls, read through the
// wrappers unwrapped takes off, so `Date.now!()`, `(Date.now as F)()` and
// `(0, Date.now)()` are each a call.
function calledThrough(node: TSESTree.Node): boolean {
  let outer = node;
  while (outer.parent !== undefined && unwrapped(outer.parent) === node) {
    outer = outer.parent;
  }
  return (
    outer.parent?.type === AST_NODE_TYPES.CallExpression &&
    outer.parent.callee === outer
  );
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
    return {
      NewExpression(node) {
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === "Date" &&
          node.arguments.length === 0 &&
          !declaredLocally(node.callee, context.sourceCode)
        ) {
          report(node, "new Date()");
        }
      },
      // A call reports through its callee, so `Date.now()` and a bare
      // `Math.random` passed as a value each report once. A local that
      // shadows the global, such as a parameter named `Math`, is not read.
      MemberExpression(node) {
        const read = memberOp(node);
        if (read === undefined) return;
        if (declaredLocally(read.object, context.sourceCode)) return;
        report(node, calledThrough(node) ? `${read.op}()` : read.op);
      },
    };
  },
});
