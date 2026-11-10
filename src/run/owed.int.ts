import {
  withDurableExecution,
  type DurableContext,
} from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EuropePmcError } from "../europepmc/client.ts";
import { askEuropePmc } from "./owed.ts";

// askEuropePmc under the SDK's local runner, with a step that asks a fake
// Europe PMC once and never retries.

beforeAll(() =>
  LocalDurableTestRunner.setupTestEnvironment({ skipTime: true }),
);
afterAll(() => LocalDurableTestRunner.teardownTestEnvironment());

const giveUp = () => ({ shouldRetry: false });

async function ask(read: () => Promise<number>) {
  const runner = new LocalDurableTestRunner<unknown>({
    handlerFunction: withDurableExecution(
      async (_event: unknown, ctx: DurableContext) =>
        askEuropePmc(ctx, "ask", "ask-wait", giveUp, read),
    ),
  });
  const execution = await runner.run({ payload: {} });
  const status = execution.getStatus();
  return {
    status,
    result: status === "SUCCEEDED" ? execution.getResult() : undefined,
    // What the step named "ask" checkpointed.
    checkpointed: execution
      .getHistoryEvents()
      .filter((event) => event.Name === "ask")
      .flatMap((event) => event.StepSucceededDetails?.Result?.Payload ?? []),
  };
}

describe("askEuropePmc", () => {
  it("returns what the step read", async () => {
    const { result, checkpointed } = await ask(() => Promise.resolve(3));
    expect(result).toEqual({ read: 3 });
    expect(checkpointed.map((payload): unknown => JSON.parse(payload))).toEqual(
      [{ read: 3 }],
    );
  });

  it("returns the wait a refusal leaves owed, under the name given", async () => {
    const { result, checkpointed } = await ask(() =>
      Promise.reject(new EuropePmcError("Europe PMC answered 429", 429, 7200)),
    );
    expect(result).toEqual({ owed: { name: "ask-wait", seconds: 7200 } });
    // The step's result keeps the shape runs in progress have saved.
    expect(checkpointed.map((payload): unknown => JSON.parse(payload))).toEqual(
      [{ refused: true, waitSeconds: 7200 }],
    );
  });

  it("owes no wait when Europe PMC asked for none", async () => {
    const { result } = await ask(() =>
      Promise.reject(new EuropePmcError("Europe PMC answered 429", 429, 0)),
    );
    expect(result).toEqual({ owed: null });
  });

  it("throws any other failure", async () => {
    const { status } = await ask(() =>
      Promise.reject(new EuropePmcError("Europe PMC answered 404", 404)),
    );
    expect(status).toBe("FAILED");
  });
});
