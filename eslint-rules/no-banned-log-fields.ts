import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "./create-rule.ts";

// Ported from podstow's no-banned-log-fields, with grantlink's own list
// (personal-data.md). Funding statements and acknowledgements name people,
// so no log line carries them, or a name. Logs carry ids and counts.
//
// A logger call is a call of trace, debug, info, log, warn, error, fatal or
// child on a receiver named `console`, `log`, `logger`, or ending `Log` or
// `Logger` (`runLog`, `requestLogger`), reached directly, as a property
// (`ctx.logger`) or through `.child(...)`; and `createLogger(...)`. Every
// argument is checked: an object's keys, nested objects and arrays, and a
// value or bare argument whose name says it holds text or a name, including
// one placed in a template literal or joined to a string with `+`.

const LEVELS = new Set([
  "trace",
  "debug",
  "info",
  "log",
  "warn",
  "error",
  "fatal",
  "child",
]);
const RECEIVER = /^(?:console|log|logger|[a-z][A-Za-z0-9]*(?:Log|Logger))$/u;

// A key or a variable is banned when one of its words is in this list, or
// it is one of the names below.
const BANNED_WORDS = new Set([
  "text",
  "texts",
  "statement",
  "statements",
  "acknowledgement",
  "acknowledgements",
  "acknowledgment",
  "acknowledgments",
  "section",
  "sections",
  "abstract",
  "excerpt",
  "snippet",
  "quote",
  "body",
  "content",
  "author",
  "authors",
  "person",
  "people",
  "investigator",
  "investigators",
  "surname",
  "forename",
  "forenames",
]);
const BANNED_NAMES = new Set([
  "name",
  "names",
  "fullname",
  "firstname",
  "lastname",
  "givenname",
  "familyname",
  "funding",
]);

const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[\s_-]+/u)
    .map((word) => word.toLowerCase())
    .filter((word) => word !== "");

export const isBannedName = (name: string): boolean =>
  BANNED_NAMES.has(name.toLowerCase()) ||
  words(name).some((word) => BANNED_WORDS.has(word));

function isLoggerReceiver(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.Identifier) return RECEIVER.test(node.name);
  if (node.type === AST_NODE_TYPES.MemberExpression) {
    return (
      !node.computed &&
      node.property.type === AST_NODE_TYPES.Identifier &&
      RECEIVER.test(node.property.name)
    );
  }
  if (node.type === AST_NODE_TYPES.CallExpression) {
    // `logger.child({ ... }).info(...)` and `createLogger(...).info(...)`.
    return isLoggerCall(node);
  }
  return false;
}

function isLoggerCall(node: TSESTree.CallExpression): boolean {
  const { callee } = node;
  if (callee.type === AST_NODE_TYPES.Identifier)
    return callee.name === "createLogger";
  return (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    LEVELS.has(callee.property.name) &&
    isLoggerReceiver(callee.object)
  );
}

// The name a value is read by: `fundingText`, or the last property of
// `paper.fundingText`.
function valueName(node: TSESTree.Node): string | undefined {
  if (node.type === AST_NODE_TYPES.Identifier) return node.name;
  if (
    node.type === AST_NODE_TYPES.MemberExpression &&
    !node.computed &&
    node.property.type === AST_NODE_TYPES.Identifier
  ) {
    return node.property.name;
  }
  return undefined;
}

function keyName(property: TSESTree.Property): string | undefined {
  const { key } = property;
  if (key.type === AST_NODE_TYPES.Literal && typeof key.value === "string")
    return key.value;
  if (!property.computed && key.type === AST_NODE_TYPES.Identifier)
    return key.name;
  return undefined;
}

export const noBannedLogFields = createRule({
  name: "no-banned-log-fields",
  meta: {
    type: "problem",
    docs: {
      description:
        "A log line carries no funding text, acknowledgements or names.",
    },
    schema: [],
    messages: {
      bannedField:
        "Log field `{{name}}` would carry funding text, acknowledgements or a name. Log ids and counts only.",
      bannedValue:
        "`{{name}}` looks like funding text, acknowledgements or a name, and would reach the logs. Log ids and counts only.",
    },
  },
  defaultOptions: [],
  create(context) {
    const checkValue = (node: TSESTree.Node): void => {
      if (node.type === AST_NODE_TYPES.ObjectExpression) {
        checkObject(node);
        return;
      }
      if (node.type === AST_NODE_TYPES.TemplateLiteral) {
        for (const expression of node.expressions) checkValue(expression);
        return;
      }
      if (node.type === AST_NODE_TYPES.BinaryExpression) {
        checkValue(node.left);
        checkValue(node.right);
        return;
      }
      if (node.type === AST_NODE_TYPES.ArrayExpression) {
        for (const element of node.elements) {
          if (element !== null) checkValue(element);
        }
        return;
      }
      const name = valueName(node);
      if (name !== undefined && isBannedName(name)) {
        context.report({ node, messageId: "bannedValue", data: { name } });
      }
    };
    const checkObject = (node: TSESTree.ObjectExpression): void => {
      for (const property of node.properties) {
        if (property.type !== AST_NODE_TYPES.Property) continue;
        const name = keyName(property);
        if (name !== undefined && isBannedName(name)) {
          context.report({
            node: property,
            messageId: "bannedField",
            data: { name },
          });
          continue;
        }
        checkValue(property.value);
      }
    };
    return {
      CallExpression(node) {
        if (!isLoggerCall(node)) return;
        for (const arg of node.arguments) checkValue(arg);
      },
    };
  },
});
