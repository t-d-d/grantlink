import { EuropePmcError } from "../europepmc/client.ts";

// Why a paper failed, as a run logs it (#378): the status of Europe PMC's
// last answer, or that the last request timed out or could not connect, or
// that a wait Europe PMC asked for was still owed so nothing was sent, or
// that the fault was in the code. `requestsLastTry` is how many requests the
// step's last try sent, not the total over its tries, which no try can see, and `tries` is how many tries the step made, both unknown
// when the step itself failed rather than returning the failure. A log line
// carries ids and counts (docs/constraints/personal-data.md), so this holds
// no message.
export interface PaperFailure {
  why: "answered" | "timeout" | "no-connection" | "waiting" | "code";
  status?: number;
  requestsLastTry?: number;
  tries?: number;
}

// What a step that reads a paper leaves: what it read, or why it failed and
// the wait Europe PMC's last refusal asked for, 0 if none. The step's result
// is checkpointed, so the run's body can log the failure and wait
// (docs/constraints/europe-pmc.md).
export type ReadOrFailed<T> =
  { read: T } | { failed: PaperFailure; waitSeconds: number };

function why(error: unknown): Pick<PaperFailure, "why" | "status"> {
  if (!(error instanceof EuropePmcError)) {
    // A reply whose body timed out as it was read.
    if (error instanceof Error && error.name === "TimeoutError") {
      return { why: "timeout" };
    }
    return { why: "code" };
  }
  const { last } = error;
  if (typeof last === "number") return { why: "answered", status: last };
  if (last === "timeout") return { why: "timeout" };
  if (last === "connection") return { why: "no-connection" };
  return { why: "waiting" };
}

// Runs `read` as one try of a paper's step. A failure the step will try
// again is thrown, so the step retries it under `retry`. On the try the step
// gives up on, the failure is returned instead, with how many requests that
// try sent by Europe PMC's client's count `sent`.
export async function readOrFailed<T>(
  attempt: number,
  retry: (error: Error, attempt: number) => { shouldRetry: boolean },
  sent: () => number,
  read: () => Promise<T>,
): Promise<ReadOrFailed<T>> {
  const before = sent();
  try {
    return { read: await read() };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (retry(failure, attempt).shouldRetry) throw error;
    return {
      failed: {
        ...why(error),
        requestsLastTry: sent() - before,
        tries: attempt,
      },
      waitSeconds:
        error instanceof EuropePmcError ? (error.waitSeconds ?? 0) : 0,
    };
  }
}
