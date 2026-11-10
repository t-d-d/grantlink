import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getRepo } from "./github.ts";

// Reads GitHub's settings for the prod environment, since an environment's
// branch rule lives in GitHub, not in the repo (deploy-gates.md). The deploy
// role trusts only prod (test/github-oidc.static.ts), so only main can
// deploy as long as prod allows only main. Reading an environment's branch
// policies needs a token with read access to the repo.

describe("fitness: only main can deploy (deploy-gates.md)", () => {
  it("lets prod deploy only from branches its own rules name", async () => {
    const environment = z
      .object({
        deployment_branch_policy: z
          .object({
            protected_branches: z.boolean(),
            custom_branch_policies: z.boolean(),
          })
          .nullable(),
      })
      .parse(await getRepo("environments/prod"));
    expect(environment.deployment_branch_policy).toEqual({
      protected_branches: false,
      custom_branch_policies: true,
    });
  }, 30_000);

  it("names main, and only main", async () => {
    const policies = z
      .object({
        branch_policies: z.array(
          z.object({ name: z.string(), type: z.string().optional() }),
        ),
      })
      .parse(await getRepo("environments/prod/deployment-branch-policies"));
    expect(
      policies.branch_policies.map((policy) => [
        policy.name,
        policy.type ?? "branch",
      ]),
    ).toEqual([["main", "branch"]]);
  }, 30_000);
});
