import {
  DurableOperationError,
  type DurableContext,
} from "@aws/durable-execution-sdk-js";
import { storeRetry } from "./retry.ts";

// Runs `log` as the step `step`, retried under the store's strategy, and
// carries on when the step still fails. A step that only writes a log line
// never ends the run, so a lost line never stops the run publishing or
// waiting out a wait a refusal left owed (#380), and never decides how
// gold set A's search ends (#370). The step's failure is
// checkpointed, so a replay takes the same path. An error the SDK raises
// for itself is not a failed step, and is thrown as it is. Its only await
// is the step itself, so a caller's await of it is replay-safe. The durable
// lint rules know it by this module's path and its exported name
// (STEP_HELPERS in eslint-rules/create-rule.ts), so a move, a rename or a
// change to its arguments changes that entry too.
export async function logOnly(
  ctx: DurableContext,
  step: string,
  log: () => void,
): Promise<void> {
  try {
    await ctx.step(
      step,
      async () => {
        log();
        return Promise.resolve();
      },
      { retryStrategy: storeRetry },
    );
  } catch (error) {
    if (!(error instanceof DurableOperationError)) throw error;
  }
}
