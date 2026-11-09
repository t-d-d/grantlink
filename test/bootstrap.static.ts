import { describe, expect, it } from "vitest";
import { readRepoFile } from "./repo.ts";

const script = readRepoFile("scripts/bootstrap.sh");
const readme = readRepoFile("README.md");

// Each row of the README's table: | `NAME` | Secret | `prod` and `eval` | ...
const listed = [
  ...readme.matchAll(/^\| `([A-Z_]+)` \| (Secret|Variable) \| ([^|]+) \|/gmu),
].flatMap(([, name = "", kind = "", environments = ""]) =>
  [...environments.matchAll(/`([a-z]+)`/gu)].map(
    ([, environment = ""]) => `${kind.toLowerCase()} ${name} ${environment}`,
  ),
);

// Each line of the script that gives GitHub a value.
const set = [
  ...script.matchAll(/gh (secret|variable) set ([A-Z_]+) .*--env ([a-z]+)/gu),
].map(([, kind = "", name = "", environment = ""]) =>
  [kind, name, environment].join(" "),
);

describe("the bootstrap script", () => {
  it("finds the README's table", () => {
    expect(listed.length).toBeGreaterThan(0);
  });

  it("sets every secret and variable the README lists, and nothing else", () => {
    expect([...set].sort()).toEqual([...listed].sort());
  });

  it("applies both stacks in us-east-1 under fixed names", () => {
    expect(script).toMatch(/^REGION=us-east-1$/mu);
    expect(script).toMatch(
      /--stack-name "\$DNS_STACK" --template-file infra\/dns\.cfn\.yml/u,
    );
    expect(script).toMatch(
      /--stack-name "\$ROLES_STACK" --template-file infra\/github-oidc\.cfn\.yml/u,
    );
  });

  it("reaches grantlink from the management account by its name", () => {
    expect(script).toMatch(
      /aws organizations list-accounts --query "Accounts\[\?Name=='grantlink'/u,
    );
    expect(script).toMatch(/role\/OrganizationAccountAccessRole/u);
  });

  // A deploy with nothing to change exits non-zero unless told not to, so
  // without the flag a second run would stop at the first stack.
  it("can run again over stacks that already exist", () => {
    const deploys = [
      ...script.matchAll(
        /aws cloudformation deploy\b[^&\n]*(?:\\\n[^&\n]*)*/gu,
      ),
    ];
    expect(deploys).toHaveLength(2);
    for (const [deploy] of deploys) {
      expect(deploy).toContain("--no-fail-on-empty-changeset");
    }
  });

  it("stops waiting for the hosted zone if the DNS deploy has ended", () => {
    expect(script).toMatch(/while \[ "\$zone" = "None" \] && kill -0 "\$dns"/u);
  });

  it("asks for no value by hand but the go-ahead", () => {
    const prompts = [...script.matchAll(/\bread -r -p\b/gu)];
    expect(prompts).toHaveLength(1);
  });
});
