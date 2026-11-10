import { StepError, type DurableContext } from "@aws/durable-execution-sdk-js";
import { describe, expect, it } from "vitest";
import { logOnly } from "./log-only.ts";

// A context whose every step ends with `outcome`. Only logOnly's await of
// the step matters here, so a plain promise stands in for the SDK's.
function contextWhoseStep(outcome: () => Promise<unknown>): DurableContext {
  const ctx: Pick<DurableContext, "step"> = {
    step: outcome as unknown as DurableContext["step"],
  };
  return ctx as DurableContext;
}

describe("a log-only step (#380)", () => {
  it("carries on when its step fails after its retries", async () => {
    const ctx = contextWhoseStep(() =>
      Promise.reject(new StepError("could not log")),
    );
    await expect(logOnly(ctx, "search-ended", () => undefined)).resolves.toBe(
      undefined,
    );
  });

  it("throws an error the SDK raises for itself as it is", async () => {
    const error = new Error("the SDK stopped the run");
    const ctx = contextWhoseStep(() => Promise.reject(error));
    await expect(logOnly(ctx, "search-ended", () => undefined)).rejects.toBe(
      error,
    );
  });
});
