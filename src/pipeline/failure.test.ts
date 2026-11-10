import { describe, expect, it } from "vitest";
import { EuropePmcError } from "../europepmc/client.ts";
import { readOrFailed } from "./failure.ts";

const giveUp = () => ({ shouldRetry: false });
const tryAgain = () => ({ shouldRetry: true });

// A count of requests sent that a read moves on by `requests`.
function counter() {
  let sent = 0;
  return {
    sent: () => sent,
    send: (requests: number) => {
      sent += requests;
    },
  };
}

describe("readOrFailed", () => {
  it("returns what the read returns", async () => {
    const { sent } = counter();
    await expect(
      readOrFailed(1, giveUp, sent, () => Promise.resolve(3)),
    ).resolves.toEqual({ read: 3 });
  });

  it("throws a failure the step will try again, so the step retries it", async () => {
    const { sent } = counter();
    const error = new EuropePmcError("Europe PMC answered 500", undefined);
    await expect(
      readOrFailed(1, tryAgain, sent, () => Promise.reject(error)),
    ).rejects.toBe(error);
  });

  it.each([
    [
      "the status of Europe PMC's last answer",
      new EuropePmcError("x", undefined, undefined, 500),
      { why: "answered", status: 500 },
    ],
    [
      "a paper Europe PMC has no full text for",
      new EuropePmcError("x", 404),
      { why: "answered", status: 404 },
    ],
    [
      "a request that timed out",
      new EuropePmcError("x", undefined, undefined, "timeout"),
      { why: "timeout" },
    ],
    [
      "a request that could not connect",
      new EuropePmcError("x", undefined, undefined, "connection"),
      { why: "no-connection" },
    ],
    [
      "a request a wait still owed stopped",
      new EuropePmcError("x", undefined, 90),
      { why: "waiting" },
    ],
    ["a fault in the code", new Error("the table refused"), { why: "code" }],
  ])(
    "returns %s, how many requests it sent and on which try, when the step gives up",
    async (_, error, why) => {
      const { sent, send } = counter();
      send(4);
      await expect(
        readOrFailed(3, giveUp, sent, () => {
          send(2);
          return Promise.reject(error);
        }),
      ).resolves.toEqual({
        failed: { ...why, requests: 2, tries: 3 },
        waitSeconds:
          error instanceof EuropePmcError ? (error.waitSeconds ?? 0) : 0,
      });
    },
  );

  it("returns the wait Europe PMC asked for when the step gives up", async () => {
    const { sent } = counter();
    const refusal = new EuropePmcError("x", 429, 7200);
    await expect(
      readOrFailed(1, giveUp, sent, () => Promise.reject(refusal)),
    ).resolves.toEqual({
      failed: { why: "answered", status: 429, requests: 0, tries: 1 },
      waitSeconds: 7200,
    });
  });

  it("passes the attempt to the retry strategy", async () => {
    const { sent } = counter();
    const seen: number[] = [];
    await readOrFailed(
      2,
      (_, attempt) => {
        seen.push(attempt);
        return { shouldRetry: false };
      },
      sent,
      () => Promise.reject(new Error("x")),
    );
    expect(seen).toEqual([2]);
  });
});
