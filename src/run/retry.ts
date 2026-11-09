import {
  createRetryStrategy,
  type RetryDecision,
} from "@aws/durable-execution-sdk-js";

// The retry strategies a run's steps pass (docs/constraints/durable-execution.md).

// Europe PMC's client already paces and backs off within one try. A step
// that still fails waits longer, up to five minutes, before the next.
export const europePmcRetry = createRetryStrategy({
  maxAttempts: 3,
  initialDelay: { seconds: 30 },
  maxDelay: { minutes: 5 },
});

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
