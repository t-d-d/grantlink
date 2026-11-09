import { describe, expect, it } from "vitest";
import { EuropePmcError } from "../europepmc/client.ts";
import { readOrRefused } from "./refused.ts";

const refusal = new EuropePmcError(
  "Europe PMC answered 429, asked to wait 7200s",
  429,
  7200,
);
const giveUp = () => ({ shouldRetry: false });
const tryAgain = () => ({ shouldRetry: true });

describe("readOrRefused", () => {
  it("returns what the read returns", async () => {
    await expect(
      readOrRefused(1, giveUp, () => Promise.resolve(3)),
    ).resolves.toEqual({ read: 3 });
  });

  it("returns the wait Europe PMC asked for when the step gives up", async () => {
    await expect(
      readOrRefused(3, giveUp, () => Promise.reject(refusal)),
    ).resolves.toEqual({ refused: true, waitSeconds: 7200 });
  });

  it("throws a refusal the step will try again, so the step retries it", async () => {
    await expect(
      readOrRefused(1, tryAgain, () => Promise.reject(refusal)),
    ).rejects.toBe(refusal);
  });

  it("passes the attempt to the retry strategy", async () => {
    const seen: number[] = [];
    await readOrRefused(
      2,
      (_, attempt) => {
        seen.push(attempt);
        return { shouldRetry: false };
      },
      () => Promise.reject(refusal),
    );
    expect(seen).toEqual([2]);
  });

  it.each([
    [
      "a Europe PMC error with no wait",
      new EuropePmcError("answered 404", 404),
    ],
    ["any other error", new Error("the table refused the write")],
  ])("throws %s", async (_, error) => {
    await expect(
      readOrRefused(3, giveUp, () => Promise.reject(error)),
    ).rejects.toBe(error);
  });
});
