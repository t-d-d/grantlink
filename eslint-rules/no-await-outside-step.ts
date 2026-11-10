import {
  createRule,
  DURABLE_METHODS,
  insideCheckpointedCallback,
  isMethodCallIn,
  stepHelperOf,
} from "./create-rule.ts";

// Ported from podstow's rule of the same name (durable-execution.md).
//
// In a durable body every await must be checkpointed. Two exemptions, and
// they are not the same set:
//
// 1. At the call site: `await ctx.step(...)` and the other durable
//    operations. The SDK checkpoints the result. A step helper such as
//    askEuropePmc counts too: its only await is its step.
// 2. As an ancestor of an inner await: only the callback of an operation
//    that checkpoints it as a unit (CHECKPOINTS_CALLBACK). A child context,
//    parallel and map run their callbacks again on every replay, so an await
//    inside one needs its own step. An argument a step helper runs inside
//    its step counts as a step's callback.
//
// `for await` reads an async source on every pass, so it counts as an await.

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
    return {
      AwaitExpression(node) {
        if (isMethodCallIn(node.argument, DURABLE_METHODS)) return;
        if (stepHelperOf(node.argument, context) !== null) return;
        if (insideCheckpointedCallback(node, context)) return;
        context.report({ node, messageId: "awaitOutsideStep" });
      },
      ForOfStatement(node) {
        if (!node.await) return;
        if (insideCheckpointedCallback(node, context)) return;
        context.report({ node, messageId: "awaitOutsideStep" });
      },
    };
  },
});
