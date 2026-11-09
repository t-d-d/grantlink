import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeDeps } from "../../test/fakes.ts";
import { EuropePmcError } from "../europepmc/client.ts";
import { makeRun, type RunSummary } from "./run.ts";

// The snapshot with a gold set B to read. The repo's own gold set B is
// empty until its labels land, so this file gives it three papers from the
// fixtures, none of them in gold set A's sample.

const { LABELLED } = vi.hoisted(() => ({
  LABELLED: ["PMC13628515", "PMC13642255", "PMC13664392"],
}));

vi.mock(import("../../evals/gold.ts"), async (original) => ({
  ...(await original()),
  goldB: {
    about: "three papers from the fixtures",
    papers: LABELLED.map((pmcid) => ({ pmcid, references: [] })),
  },
}));

beforeAll(() =>
  LocalDurableTestRunner.setupTestEnvironment({ skipTime: true }),
);
afterAll(() => LocalDurableTestRunner.teardownTestEnvironment());

async function runWith(fake: ReturnType<typeof fakeDeps>) {
  const runner = new LocalDurableTestRunner<RunSummary>({
    handlerFunction: withDurableExecution(makeRun(fake.deps)),
  });
  const execution = await runner.run({ payload: {} });
  const status = execution.getStatus();
  return {
    status,
    result: status === "SUCCEEDED" ? execution.getResult() : undefined,
  };
}

// Europe PMC answering the first labelled paper's full text with `first`
// once the snapshot starts, and recording every gold set B paper the
// snapshot asks about. The run reads the same papers first, as it finds
// them in its own search.
function failingFirstLabelled(first: () => Promise<string>) {
  const fake = fakeDeps();
  const real = fake.deps.europePmc;
  let snapshot = false;
  const hasSnapshot = fake.deps.text.hasSnapshot.bind(fake.deps.text);
  fake.deps.text.hasSnapshot = (id) => {
    snapshot = true;
    return hasSnapshot(id);
  };
  const asked: string[] = [];
  fake.deps.europePmc = {
    search: real.search.bind(real),
    grants: real.grants.bind(real),
    fullText: (pmcid) => {
      if (!snapshot) return real.fullText(pmcid);
      if (LABELLED.includes(pmcid)) asked.push(pmcid);
      if (pmcid === LABELLED[0]) return first();
      return real.fullText(pmcid);
    },
  };
  return { fake, asked };
}

describe("gold set B in the eval snapshot (evals.md)", () => {
  it("keeps every labelled paper when each can be read", async () => {
    const fake = fakeDeps();
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toMatchObject({
      taken: true,
      papers: 2 + LABELLED.length,
    });
  });

  it.each([
    new EuropePmcError(
      "Europe PMC answered 429, asked to wait 7200s",
      429,
      7200,
    ),
    new EuropePmcError("Europe PMC answered 404", 404),
  ])(
    "asks Europe PMC nothing more once one labelled paper fails ($message)",
    async (error) => {
      const { fake, asked } = failingFirstLabelled(() => Promise.reject(error));
      const { status, result } = await runWith(fake);
      expect(status).toBe("SUCCEEDED");
      expect(result?.snapshot).toEqual({
        taken: false,
        reason: "a gold set B paper could not be read",
      });
      expect(asked).toEqual([LABELLED[0]]);
      expect(fake.text.has("eval/s1/manifest.json")).toBe(false);
    },
  );

  it("asks Europe PMC nothing more once one labelled paper has no funding text", async () => {
    const { fake, asked } = failingFirstLabelled(() =>
      Promise.resolve("<article></article>"),
    );
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toEqual({
      taken: false,
      reason: "a gold set B paper could not be read",
    });
    expect(asked).toEqual([LABELLED[0]]);
    expect(fake.text.has("eval/s1/manifest.json")).toBe(false);
  });
});
