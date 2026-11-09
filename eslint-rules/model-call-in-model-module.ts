import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule, repoPath } from "./create-rule.ts";

// One model, in one place (model-calls.md). Outside the model module no code
// names OpenRouter's host, names a model id, or imports a model client. A
// second call or a second pinned id would skip the module's provider
// routing, its checks on the reply, or the eval that scored the pinned model.
type Options = [{ owner: string }];
type MessageId = "openRouter" | "modelId" | "modelClient";

const OPENROUTER = /openrouter\.ai/iu;
// OpenRouter's ids ("anthropic/claude-haiku-5.5") and Anthropic's own
// ("claude-haiku-5-5").
const MODEL_ID = /^(?:[a-z0-9-]+\/)?claude-[a-z0-9.-]+$|^anthropic\/\S+$/iu;
const CLIENTS = ["openai", "@openrouter", "@anthropic-ai", "ai", "@ai-sdk"];

const isClient = (source: string): boolean =>
  CLIENTS.some((c) => source === c || source.startsWith(`${c}/`));

export const modelCallInModelModule = createRule<Options, MessageId>({
  name: "model-call-in-model-module",
  meta: {
    type: "problem",
    docs: {
      description:
        "Only the model module calls OpenRouter, names a model, or imports a model client.",
    },
    schema: [
      {
        type: "object",
        properties: { owner: { type: "string" } },
        required: ["owner"],
        additionalProperties: false,
      },
    ],
    messages: {
      openRouter:
        "Only {{owner}} calls OpenRouter. Ask {{owner}} for what you need.",
      modelId: "The model id is set once, in {{owner}}. Import it from there.",
      modelClient:
        "Only {{owner}} imports a model client ({{source}}). Ask {{owner}} for what you need.",
    },
  },
  defaultOptions: [{ owner: "" }],
  create(context, [{ owner }]) {
    if (repoPath(context) === owner) return {};
    const checkText = (node: TSESTree.Node, text: string): void => {
      if (OPENROUTER.test(text)) {
        context.report({ node, messageId: "openRouter", data: { owner } });
      } else if (MODEL_ID.test(text.trim())) {
        context.report({ node, messageId: "modelId", data: { owner } });
      }
    };
    const checkSource = (node: TSESTree.Node, source: string): void => {
      if (isClient(source)) {
        context.report({
          node,
          messageId: "modelClient",
          data: { owner, source },
        });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        // An import's source is checked as a client, not as text.
        if (
          node.parent.type === AST_NODE_TYPES.ImportDeclaration ||
          node.parent.type === AST_NODE_TYPES.ExportNamedDeclaration ||
          node.parent.type === AST_NODE_TYPES.ExportAllDeclaration ||
          node.parent.type === AST_NODE_TYPES.ImportExpression
        ) {
          checkSource(node, node.value);
          return;
        }
        checkText(node, node.value);
      },
      TemplateElement(node) {
        checkText(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
});
