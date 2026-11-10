import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotKeys } from "../../evals/gold.ts";
import { fakeDeps } from "../../test/fakes.ts";
import { EuropePmcError } from "../europepmc/client.ts";
import { makeRun, type RunSummary } from "./run.ts";

// The snapshot with a gold set B of its own, passed in through the run's
// deps, so these tests never read the repo's labels. Its three papers are
// recorded fixtures the run reads first in its own search, as a labelled
// paper may be, and none is in gold set A's sample.

const LABELLED = ["PMC13628515", "PMC13642255", "PMC13664392"];

const goldB = (pmcids: string[]) => ({
  about: "a test's own gold set B",
  papers: pmcids.map((pmcid) => ({ pmcid, references: [] })),
});

const labelledDeps = () => fakeDeps({ gold: { goldB: goldB(LABELLED) } });

const manifestKey = (fake: ReturnType<typeof fakeDeps>) =>
  snapshotKeys.manifest(fake.deps.gold.snapshotId);

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
    // The local runner's clock when the run ended.
    ended: Date.now(),
    result: status === "SUCCEEDED" ? execution.getResult() : undefined,
  };
}

// Europe PMC answering the first labelled paper's full text with `first`
// once the snapshot starts, and recording every gold set B paper the
// snapshot asks about. The run reads the same papers first, as it finds
// them in its own search.
function failingFirstLabelled(first: () => Promise<string>) {
  const fake = labelledDeps();
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
    sent: real.sent.bind(real),
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
    const fake = labelledDeps();
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toMatchObject({
      taken: true,
      papers: 2 + LABELLED.length,
    });
    expect(fake.text.has(manifestKey(fake))).toBe(true);
  });

  it("leaves the snapshot for the next run when a labelled paper cannot be read", async () => {
    // PMC0000009 has no fixture, so the fake Europe PMC answers 503.
    const fake = fakeDeps({
      gold: { goldB: goldB([...LABELLED.slice(0, 1), "PMC0000009"]) },
    });
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.published).toMatchObject({ published: true });
    expect(result?.snapshot).toEqual({
      taken: false,
      reason: "a gold set B paper could not be read",
    });
    expect(fake.text.has(manifestKey(fake))).toBe(false);
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
      expect(fake.text.has(manifestKey(fake))).toBe(false);
    },
  );

  it("ends only once a labelled paper's refusal has been waited out", async () => {
    let notBefore = 0;
    const { fake } = failingFirstLabelled(() => {
      notBefore = Date.now() + 7_200_000;
      return Promise.reject(
        new EuropePmcError(
          "Europe PMC answered 429, asked to wait 7200s",
          429,
          7200,
        ),
      );
    });
    const { status, ended } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(notBefore).toBeGreaterThan(0);
    expect(ended).toBeGreaterThanOrEqual(notBefore);
  });

  it("keeps a labelled paper with no funding text or awards, and goes on to the rest (#399)", async () => {
    const { fake, asked } = failingFirstLabelled(() =>
      Promise.resolve("<article></article>"),
    );
    const { status, result } = await runWith(fake);
    expect(status).toBe("SUCCEEDED");
    expect(result?.snapshot).toMatchObject({
      taken: true,
      papers: 2 + LABELLED.length,
    });
    expect(asked).toEqual(LABELLED);
    const manifest = JSON.parse(String(fake.text.get(manifestKey(fake)))) as {
      papers: { pmcid: string; set: string }[];
    };
    expect(manifest.papers).toContainEqual(
      expect.objectContaining({ pmcid: LABELLED[0], set: "B" }),
    );
    expect(
      JSON.parse(String(fake.text.get(snapshotKeys.paper(LABELLED[0] ?? "")))),
    ).toEqual({ pmcid: LABELLED[0], text: [], awards: [] });
  });
});
