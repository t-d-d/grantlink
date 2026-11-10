import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readTemplate, resource, trustOf } from "./cfn.ts";
import { getRepo } from "./github.ts";

// Checks the OIDC subject each role trusts against GitHub's own record of
// the repository, so an id typed wrongly in both the template and
// test/github-oidc.static.ts, or a rename or a transfer, fails here and not
// only at a deploy (#52). GitHub answers a renamed or transferred
// repository's old name with its new record, so the name here can go stale
// without hiding a change. test/github.ts names it.
const Repository = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  owner: z.object({
    id: z.number().int().positive(),
    login: z.string().min(1),
  }),
});

const template = readTemplate("infra/github-oidc.cfn.yml");
// What each role trusts after the repository's own subject: an environment,
// or main for the conformance run, whose job names none (#50).
const roles = {
  DeployRole: "environment:prod",
  CiEvalRole: "environment:eval",
  ConformanceRole: "ref:refs/heads/main",
};

const subjectOf = (role: string): unknown =>
  trustOf(resource(template, role))[0]?.Condition?.StringEquals?.[
    "token.actions.githubusercontent.com:sub"
  ];

// GitHub's subject for a repository made after 15 July 2026 (#48).
let subject: string;

beforeAll(async () => {
  const { id, name, owner } = Repository.parse(await getRepo());
  subject = `repo:${owner.login}@${String(owner.id)}/${name}@${String(id)}`;
}, 30_000);

describe("the roles' OIDC subject", () => {
  it.each(Object.entries(roles))(
    "%s trusts GitHub's subject for %s",
    (role, context) => {
      expect(subjectOf(role)).toBe(`${subject}:${context}`);
    },
  );
});
