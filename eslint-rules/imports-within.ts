import { dirname, posix } from "node:path";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule, repoPath } from "./create-rule.ts";

// The eval's fingerprint covers the paths it lists (evals.md). A file in
// one of them may import a package or a Node built-in, or a file in one of
// the paths, and nothing else, so a change that alters a score always
// changes the fingerprint. Static imports, re-exports and `import()` all
// count.
type Options = [{ paths: readonly string[] }];

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

export const importsWithin = createRule<Options, "outside">({
  name: "imports-within",
  meta: {
    type: "problem",
    docs: {
      description:
        "A file in the fingerprinted paths imports only from those paths or packages.",
    },
    schema: [
      {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" } },
        },
        required: ["paths"],
        additionalProperties: false,
      },
    ],
    messages: {
      outside:
        "{{source}} is outside the eval's fingerprint ({{paths}}). Move it in, or import a package.",
    },
  },
  defaultOptions: [{ paths: [] }],
  create(context, [{ paths }]) {
    const from = dirname(repoPath(context));
    const check = (node: TSESTree.Node, source: string): void => {
      if (!source.startsWith(".") && !source.startsWith("/")) return;
      const target = posix.normalize(posix.join(from, source));
      if (paths.some((root) => within(target, root))) return;
      context.report({
        node,
        messageId: "outside",
        data: { source, paths: paths.join(", ") },
      });
    };
    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value);
      },
      ImportExpression(node) {
        if (
          node.source.type === AST_NODE_TYPES.Literal &&
          typeof node.source.value === "string"
        ) {
          check(node, node.source.value);
        }
      },
    };
  },
});
