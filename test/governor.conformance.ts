import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getRepo } from "./github.ts";
import { readRepoFile } from "./repo.ts";

// Governor links each ticket that starts with a `Blocked until:` line as
// blocked by its wait ticket, so the ticket's sidebar shows the hold (#461).
// It links nothing to a closed wait ticket, so if someone closes it the
// holds vanish from the sidebars and nothing else goes red (#471).
// `waits.issue` is required here, though governor's schema leaves it
// optional: with no wait ticket named there is nothing to check, and the
// test must say so rather than pass.
const Config = z.object({
  waits: z.object({ issue: z.number().int().positive() }),
});

describe("governor's wait ticket", () => {
  it("stays open", async () => {
    const issue = Config.parse(
      JSON.parse(readRepoFile(".github/governor.json")),
    ).waits.issue;
    // fetch follows GitHub's redirect for an issue moved to another
    // repository, and the moved issue takes a new number there, so the
    // number in the reply shows whether the wait ticket is still here.
    const { number, state, pull_request } = z
      .object({
        number: z.number().int().positive(),
        state: z.enum(["open", "closed"]),
        pull_request: z.unknown().optional(),
      })
      .parse(await getRepo(`issues/${String(issue)}`));
    expect(number, `#${String(issue)} moved to another repository`).toBe(issue);
    expect(pull_request, `#${String(issue)} is a pull request`).toBeUndefined();
    expect(state, `#${String(issue)}, governor's wait ticket`).toBe("open");
  }, 30_000);
});
