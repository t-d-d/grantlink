import { EuropePmcError } from "../europepmc/client.ts";

// A step that reads from Europe PMC returns, rather than throws, the wait
// that Europe PMC's last refusal asked for when the step gives up on it.
// Its result is checkpointed, so the run's body can wait that long before
// it asks Europe PMC anything more, for any paper, however long that is
// (docs/constraints/europe-pmc.md). Any other failure throws as before,
// and `retry` is the step's own retry strategy.
export type Read<T> = { read: T } | { refused: true; waitSeconds: number };

export async function readOrRefused<T>(
  attempt: number,
  retry: (error: Error, attempt: number) => { shouldRetry: boolean },
  read: () => Promise<T>,
): Promise<Read<T>> {
  try {
    return { read: await read() };
  } catch (error) {
    if (
      error instanceof EuropePmcError &&
      error.waitSeconds !== undefined &&
      !retry(error, attempt).shouldRetry
    ) {
      return { refused: true, waitSeconds: error.waitSeconds };
    }
    throw error;
  }
}
