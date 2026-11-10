import type { Read } from "../pipeline/refused.ts";

// A wait Europe PMC asked for when it refused a paper, not yet waited. The
// run carries it to the next step that asks Europe PMC and waits just
// before that step, so a step that sends Europe PMC nothing, such as
// publishing, never waits on it (docs/constraints/europe-pmc.md, #179).
// Each caller writes `ctx.wait(owed.name, { seconds: owed.seconds })` in
// place, where the lint rules can see it.
export type Owed = { name: string; seconds: number } | null;

// The wait a failed read's outcome leaves owed, named `name`: a paper's,
// or a search's.
export const owedAfter = (
  name: string,
  outcome: Read<unknown> | undefined,
): Owed =>
  outcome !== undefined && "refused" in outcome && outcome.waitSeconds > 0
    ? { name, seconds: outcome.waitSeconds }
    : null;
