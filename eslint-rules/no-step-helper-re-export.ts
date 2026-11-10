import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import {
  createRule,
  exportedName,
  helperNamed,
  holdsStepHelper,
  importOf,
  moduleOf,
  repoPath,
  withoutExtension,
} from "./create-rule.ts";

// The durable rules know a step helper such as askEuropePmc by the module
// that exports it and its name there (STEP_HELPERS). An export that passes
// a helper on from another module, or renames it in its own, gives callers
// a way in the rules cannot follow, so it is refused. That covers
// `export { askEuropePmc } from "./owed.ts"`, `export * from "./owed.ts"`,
// `export * as owed from "./owed.ts"`, exporting an imported helper or a
// namespace import of its module, and `export { askEuropePmc as ask }` in
// owed.ts itself. A type-only export carries no function, so it passes.
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
    // A local binding exported from this file passes a helper on when it
    // imports one, or imports a whole module that holds one.
    const checkLocal = (node: TSESTree.Node, local: TSESTree.Node): void => {
      if (local.type !== AST_NODE_TYPES.Identifier) return;
      const binding = importOf(local, context);
      if (binding === null) return;
      if (
        binding.name === null
          ? holdsStepHelper(binding.module)
          : helperNamed(binding.module, binding.name) !== null
      ) {
        report(node, binding.module);
      }
    };
    return {
      ExportAllDeclaration(node) {
        if (node.exportKind === "type") return;
        const module = moduleOf(node.source.value, context);
        if (module !== null && holdsStepHelper(module)) report(node, module);
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === "type") return;
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
          if (
            helperNamed(here, local) !== null &&
            exportedName(specifier.exported) !== local
          ) {
            report(specifier, here);
            continue;
          }
          checkLocal(specifier, specifier.local);
        }
      },
      ExportDefaultDeclaration(node) {
        checkLocal(node, node.declaration);
      },
    };
  },
});
