import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readTemplate, resource, trustOf } from "./cfn.ts";

// Checks the OIDC subject each role trusts against GitHub's own record of
// the repository, so an id typed wrongly in both the template and
// test/github-oidc.static.ts, or a rename or a transfer, fails here and not
// only at a deploy (#52). GitHub answers a renamed or transferred
// repository's old name with its new record, so the name here can go stale
// without hiding a change.
const repository = "t-d-d/grantlink";

// Anonymous calls share a small rate limit per address, so a token is sent
// when GITHUB_TOKEN holds one: a token a workflow maps, or in a cloud
// session the placeholder its proxy replaces, which Node's fetch reaches
// only with NODE_USE_ENV_PROXY=1 set. An empty token, as a workflow passes for a
// secret that is not set, counts as none.
const { GITHUB_TOKEN } = z
  .object({
    GITHUB_TOKEN: z
      .string()
      .optional()
      .transform((token) => (token === "" ? undefined : token)),
  })
  .parse(process.env);

const Repository = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  owner: z.object({
    id: z.number().int().positive(),
    login: z.string().min(1),
  }),
});

const template = readTemplate("infra/github-oidc.cfn.yml");
const roles = { DeployRole: "prod", CiEvalRole: "eval" };

const subjectOf = (role: string): unknown =>
  trustOf(resource(template, role))[0]?.Condition?.StringEquals?.[
    "token.actions.githubusercontent.com:sub"
  ];

// GitHub's subject for a repository made after 15 July 2026 (#48).
let subject: string;

beforeAll(async () => {
  const response = await fetch(`https://api.github.com/repos/${repository}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(GITHUB_TOKEN === undefined
        ? {}
        : { Authorization: `Bearer ${GITHUB_TOKEN}` }),
    },
  });
  // GitHub's reply says why a call failed, such as a bad token or the rate
  // limit, so a failure shows it.
  const reply = await response.text();
  expect(response.status, reply).toBe(200);
  const { id, name, owner } = Repository.parse(JSON.parse(reply));
  subject = `repo:${owner.login}@${String(owner.id)}/${name}@${String(id)}`;
}, 30_000);

describe("the roles' OIDC subject", () => {
  it.each(Object.entries(roles))(
    "%s trusts GitHub's subject for the %s environment",
    (role, environment) => {
      expect(subjectOf(role)).toBe(`${subject}:environment:${environment}`);
    },
  );
});
