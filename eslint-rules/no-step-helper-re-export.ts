import { AST_NODE_TYPES, TSESLint } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import type { StepHelper } from "./create-rule.ts";
import {
  bindingOf,
  createRule,
  exportedName,
  helperNamed,
  holdsStepHelper,
  importOf,
  lookup,
  moduleOf,
  repoPath,
  unwrapped,
  withoutExtension,
} from "./create-rule.ts";

// The durable rules know a step helper such as askEuropePmc by the module
// that exports it and its name there (STEP_HELPERS). An export that passes
// a helper on from another module, or renames it in its own, gives callers
// a way in the rules cannot follow, so it is refused. That covers
// `export { askEuropePmc } from "./owed.ts"`, `export * from "./owed.ts"`,
// `export * as owed from "./owed.ts"`, exporting an imported helper, a
// namespace import of its module or a helper read from one, whether by name,
// as a constant or as the default, and `export { askEuropePmc as ask }`,
// `export const ask = askEuropePmc` or `export default askEuropePmc` in
// owed.ts itself, directly or through a chain of local aliases such as
// `const ask = askEuropePmc; export { ask }`. A type-only export carries no
// function, so it passes.
export const noStepHelperReExport = createRule({
  name: "no-step-helper-re-export",
  meta: {
    type: "problem",
    docs: {
      description:
        "A step helper must be imported from the module that defines it, under its own name.",
    },
    schema: [],
    messages: {
      reExport:
        "This export passes on a step helper from {{module}}, and the durable lint rules would not recognise a call through it. Import the helper from {{module}} where it is called.",
    },
  },
  defaultOptions: [],
  create(context) {
    const here = withoutExtension(repoPath(context));
    const report = (node: TSESTree.Node, module: string): void => {
      context.report({ node, messageId: "reExport", data: { module } });
    };
    // This module's own helper that an identifier names, directly or through
    // a chain of local aliases such as `const ask = askEuropePmc`. Any name
    // along the chain counts, so an alias of askEuropePmc counts even when
    // askEuropePmc is itself an alias. A later write to an alias does not
    // stop the chain: the rule refuses what the export may pass on.
    const localHelper = (
      identifier: TSESTree.Identifier,
      seen: ReadonlySet<TSESLint.Scope.Variable> = new Set(),
    ): StepHelper | null => {
      const helper = helperNamed(here, identifier.name);
      if (helper !== null) return helper;
      const variable = lookup(
        identifier.name,
        context.sourceCode.getScope(identifier),
      );
      const def = variable?.defs[0];
      if (
        variable === null ||
        seen.has(variable) ||
        variable.defs.length !== 1 ||
        def?.type !== TSESLint.Scope.DefinitionType.Variable ||
        def.node.id !== def.name ||
        def.node.init?.type !== AST_NODE_TYPES.Identifier
      ) {
        return null;
      }
      return localHelper(def.node.init, new Set([...seen, variable]));
    };
    // The module whose helper an exported value passes on under a name of
    // its own choosing, or null. That is an imported helper, a namespace
    // import of a module that holds one, a helper read from a namespace
    // import, or this module's own helper or a local alias of it, read
    // through any wrapper that unwrapped takes off.
    const passedOn = (exported: TSESTree.Node): string | null => {
      const value = unwrapped(exported);
      if (value.type === AST_NODE_TYPES.Identifier) {
        const binding = importOf(value, context);
        if (binding === null) {
          return localHelper(value) === null ? null : here;
        }
        const passes =
          binding.name === null
            ? holdsStepHelper(binding.module)
            : helperNamed(binding.module, binding.name) !== null;
        return passes ? binding.module : null;
      }
      const binding = bindingOf(value, context);
      if (typeof binding?.name !== "string") return null;
      return helperNamed(binding.module, binding.name) === null
        ? null
        : binding.module;
    };
    const checkValue = (node: TSESTree.Node, value: TSESTree.Node): void => {
      const module = passedOn(value);
      if (module !== null) report(node, module);
    };
    return {
      ExportAllDeclaration(node) {
        if (node.exportKind === "type") return;
        const module = moduleOf(node.source.value, context);
        if (module !== null && holdsStepHelper(module)) report(node, module);
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === "type") return;
        if (node.declaration?.type === AST_NODE_TYPES.VariableDeclaration) {
          for (const declarator of node.declaration.declarations) {
            if (declarator.init !== null)
              checkValue(declarator, declarator.init);
          }
        }
        const from =
          node.source === null ? null : moduleOf(node.source.value, context);
        for (const specifier of node.specifiers) {
          if (specifier.exportKind === "type") continue;
          const local = exportedName(specifier.local);
          if (node.source !== null) {
            if (from !== null && helperNamed(from, local) !== null)
              report(specifier, from);
            continue;
          }
          // This module's own helper, exported under its own name, is how
          // callers reach it, whether the local is the helper or an alias.
          const own =
            specifier.local.type === AST_NODE_TYPES.Identifier
              ? localHelper(specifier.local)
              : null;
          if (own !== null && exportedName(specifier.exported) === own.name) {
            continue;
          }
          checkValue(specifier, specifier.local);
        }
      },
      ExportDefaultDeclaration(node) {
        checkValue(node, node.declaration);
      },
    };
  },
});
