import { createRule, DURABLE_METHODS, isMethodCallIn } from "./create-rule.ts";

// Ported from podstow's rule of the same name (durable-execution.md).
//
// In a durable body every await must be checkpointed. Two exemptions, and
// they are not the same set:
//
// 1. At the call site: `await ctx.step(...)` and the other durable
//    operations. The SDK checkpoints the result.
// 2. As an ancestor of an inner await: only the operations that checkpoint
//    their callback as a unit (a step, the submitter of waitForCallback, the
//    check of waitForCondition). A child context, parallel and map run their
//    callbacks again on every replay, so an await inside one needs its own
//    step.
const CHECKPOINTS_CALLBACK = new Set([
  "step",
  "waitForCallback",
  "waitForCondition",
]);

export const noAwaitOutsideStep = createRule({
  name: "no-await-outside-step",
  meta: {
    type: "problem",
    docs: {
      description:
        "An await in a durable body must be a durable operation, or sit inside a step.",
    },
    schema: [],
    messages: {
      awaitOutsideStep:
        "This await is not checkpointed, so a replay runs it again and may branch differently. Move it inside `ctx.step(...)`, or add `// eslint-disable-next-line grantlink/no-await-outside-step -- <why it is replay-safe>`.",
    },
  },
  defaultOptions: [],
  create(context) {
    const { sourceCode } = context;
    return {
      AwaitExpression(node) {
        if (isMethodCallIn(node.argument, DURABLE_METHODS)) return;
        const inStep = sourceCode
          .getAncestors(node)
          .some((ancestor) => isMethodCallIn(ancestor, CHECKPOINTS_CALLBACK));
        if (inStep) return;
        context.report({ node, messageId: "awaitOutsideStep" });
      },
    };
  },
});
