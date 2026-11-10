import { afterAll, describe, expect, it, vi } from "vitest";
import { goldA, goldB, pinned } from "../../evals/gold.ts";

// The run's tests pass small gold sets in through its deps. This checks the
// deployed handler passes the repo's own: the labels in evals/gold-b.json,
// gold set A's query and seed, and the snapshot id evals/snapshot.json pins.

vi.stubEnv("TABLE_NAME", "table");
vi.stubEnv("TEXT_BUCKET", "text");
vi.stubEnv("SITE_BUCKET", "site");
vi.stubEnv("CODE_VERSION", "test");
afterAll(() => vi.unstubAllEnvs());

describe("the handler's gold sets", () => {
  it("are the repo's own, with the pinned snapshot id", async () => {
    const { liveDeps } = await import("./handler.ts");
    expect(liveDeps().gold).toEqual({ goldA, goldB, snapshotId: pinned.id });
  });
});
