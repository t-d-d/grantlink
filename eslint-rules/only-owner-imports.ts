import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule, repoPath } from "./create-rule.ts";

// One way in to a client: each listed module may be imported only by the
// file that owns it (storage.md). An owner may not import another owner's
// modules. Static imports, re-exports and `import()` all count. A type-only
// import counts too: the owner exports the types the rest of the code needs.
interface Owner {
  owner: string;
  modules: readonly string[];
}

type Options = [{ owners: readonly Owner[] }];

const matches = (source: string, module: string): boolean =>
  source === module || source.startsWith(`${module}/`);

export const onlyOwnerImports = createRule<Options, "notOwner">({
  name: "only-owner-imports",
  meta: {
    type: "problem",
    docs: {
      description: "A listed module is imported only by the file that owns it.",
    },
    schema: [
      {
        type: "object",
        properties: {
          owners: {
            type: "array",
            items: {
              type: "object",
              properties: {
                owner: { type: "string" },
                modules: { type: "array", items: { type: "string" } },
              },
              required: ["owner", "modules"],
              additionalProperties: false,
            },
          },
        },
        required: ["owners"],
        additionalProperties: false,
      },
    ],
    messages: {
      notOwner: "Only {{owner}} may import {{module}}. Call {{owner}} instead.",
    },
  },
  defaultOptions: [{ owners: [] }],
  create(context, [{ owners }]) {
    const path = repoPath(context);
    const check = (node: TSESTree.Node, source: string): void => {
      for (const { owner, modules } of owners) {
        const module = modules.find((m) => matches(source, m));
        if (module === undefined || owner === path) continue;
        context.report({
          node,
          messageId: "notOwner",
          data: { owner, module },
        });
      }
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
