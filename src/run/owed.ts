import type {
  DurableContext,
  RetryDecision,
} from "@aws/durable-execution-sdk-js";
import { readOrRefused } from "../pipeline/refused.ts";

// A wait Europe PMC asked for when it refused a paper, not yet waited. The
// run carries it to the next step that asks Europe PMC and waits just
// before that step, so a step that sends Europe PMC nothing, such as
// publishing, never waits on it (docs/constraints/europe-pmc.md, #179).
// Each caller writes `ctx.wait(owed.name, { seconds: owed.seconds })` in
// place, where the lint rules can see it.
export type Owed = { name: string; seconds: number } | null;

// What a step that asks Europe PMC leaves: what it read, or the wait its
// refusal leaves owed.
export type Asked<T> = { read: T } | { owed: Owed };

// Runs `read` as the step `step`, retried under `retry`, and returns what
// it read, or the wait named `wait` that Europe PMC's refusal leaves owed
// when the step gives up on it. Any other failure throws. The step
// checkpoints readOrRefused's result, whose shape runs in progress have
// saved (docs/constraints/durable-execution.md). Its only await is the step
// itself, so a caller's await of it is replay-safe. The durable lint rules
// know it by name (STEP_HELPERS in eslint-rules/create-rule.ts), so a rename
// or a change to its arguments changes that entry too.
export async function askEuropePmc<T>(
  ctx: DurableContext,
  step: string,
  wait: string,
  retry: (error: Error, attempt: number) => RetryDecision,
  read: () => Promise<T>,
): Promise<Asked<T>> {
  const outcome = await ctx.step(
    step,
    async ({ attempt }) => readOrRefused(attempt, retry, read),
    { retryStrategy: retry },
  );
  if ("read" in outcome) return { read: outcome.read };
  return {
    owed:
      outcome.waitSeconds > 0
        ? { name: wait, seconds: outcome.waitSeconds }
        : null,
  };
}
