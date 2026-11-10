import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readRepoFile } from "./repo.ts";

// Governor links each ticket that starts with a `Blocked until:` line as
// blocked by its wait ticket, so the ticket's sidebar shows the hold (#461).
// It links nothing to a closed wait ticket, so if someone closes it the
// holds vanish from the sidebars and nothing else goes red (#471).
const repository = "t-d-d/grantlink";

// A token as test/github-oidc.conformance.ts takes one. An empty token, as a
// workflow passes for a secret that is not set, counts as none.
const { GITHUB_TOKEN } = z
  .object({
    GITHUB_TOKEN: z
      .string()
      .optional()
      .transform((token) => (token === "" ? undefined : token)),
  })
  .parse(process.env);

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
    const response = await fetch(
      `https://api.github.com/repos/${repository}/issues/${String(issue)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          ...(GITHUB_TOKEN === undefined
            ? {}
            : { Authorization: `Bearer ${GITHUB_TOKEN}` }),
        },
      },
    );
    const reply = await response.text();
    expect(response.status, reply).toBe(200);
    const { number, state, pull_request } = z
      .object({
        number: z.number().int().positive(),
        state: z.enum(["open", "closed"]),
        pull_request: z.unknown().optional(),
      })
      .parse(JSON.parse(reply));
    expect(number, `#${String(issue)} moved to another repository`).toBe(issue);
    expect(pull_request, `#${String(issue)} is a pull request`).toBeUndefined();
    expect(state, `#${String(issue)}, governor's wait ticket`).toBe("open");
  }, 30_000);
});
