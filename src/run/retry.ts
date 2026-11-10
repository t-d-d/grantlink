import {
  createRetryStrategy,
  type RetryDecision,
} from "@aws/durable-execution-sdk-js";
import { EuropePmcError } from "../europepmc/client.ts";

// The retry strategies a run's steps pass (docs/constraints/durable-execution.md).

// Europe PMC's client already paces and backs off within one try. A step
// that still fails waits longer before the next: 30 seconds, then a
// minute, or as long as Europe PMC's last refusal asked if that is longer.
// There is no jitter, so no step retry comes sooner than Europe PMC asked
// (docs/constraints/europe-pmc.md). A step asked to wait more than an hour
// does not ask again in this run: its paper waits for the next run, the
// run's search fails the run once that wait has passed, so the run
// publishes nothing, and gold set A's search leaves the snapshot for the
// next run. Either way the run asks
// Europe PMC nothing more until the wait has passed
// (readOrRefused in src/pipeline/refused.ts).
const STEP_TRIES = 3;
const FIRST_STEP_WAIT_SECONDS = 30;
const LONGEST_STEP_WAIT_SECONDS = 3_600;

export function europePmcRetry(error: Error, attempt: number): RetryDecision {
  if (attempt >= STEP_TRIES) return { shouldRetry: false };
  const asked = error instanceof EuropePmcError ? error.waitSeconds : undefined;
  if (asked !== undefined && asked > LONGEST_STEP_WAIT_SECONDS) {
    return { shouldRetry: false };
  }
  const backoff = FIRST_STEP_WAIT_SECONDS * 2 ** (attempt - 1);
  return {
    shouldRetry: true,
    delay: { seconds: Math.max(backoff, asked ?? 0) },
  };
}

// Only Europe PMC's own refusals and failures are worth asking again in
// this run, after the longer wait. A paper it has no full text for (a 4xx
// other than 429) is not, and nor is a fault in the paper or the code,
// which gives the same result however often it is tried.
export const paperRetry = (error: Error, attempt: number): RetryDecision =>
  error.name === "EuropePmcError" &&
  !/answered 4(?!29)\d\d/u.test(error.message)
    ? europePmcRetry(error, attempt)
    : { shouldRetry: false };

export const storeRetry = createRetryStrategy({
  maxAttempts: 3,
  initialDelay: { seconds: 5 },
});
