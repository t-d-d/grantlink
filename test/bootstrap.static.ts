import { describe, expect, it } from "vitest";
import { readTemplate } from "./cfn.ts";
import { readRepoFile } from "./repo.ts";

const script = readRepoFile("scripts/bootstrap.sh");
const readme = readRepoFile("README.md");

// The script with each continuation joined, so one command is one line.
const lines = script
  .replace(/[ \t]*\\\n\s*/gu, " ")
  .split("\n")
  .map((line) => line.trim());
const index = (pattern: RegExp): number =>
  lines.findIndex((line) => pattern.test(line));

// Each stack the script deploys, by the variable that names it.
const templates = new Map(
  lines.flatMap((line) => {
    const [, stack, file] =
      /^aws cloudformation deploy .*--stack-name "\$(\w+)" --template-file (\S+)/u.exec(
        line,
      ) ?? [];
    return stack && file ? [[stack, file] as const] : [];
  }),
);
const stackLabels: Record<string, string> = {
  DNS_STACK: "DNS",
  ROLES_STACK: "roles",
};

// Each value the script reads from a stack's outputs, by its variable.
const reads = new Map(
  lines.flatMap((line) => {
    const [, variable, stack, key] =
      /^(\w+)=\$\(output "\$(\w+)" (\w+)\)$/u.exec(line) ?? [];
    return variable && stack && key
      ? [[variable, { stack, key }] as const]
      : [];
  }),
);

// The README's words for what a variable holds.
const describeValue = (variable: string): string => {
  const read = reads.get(variable);
  if (read) {
    return `The ${stackLabels[read.stack] ?? read.stack} stack's \`${read.key}\` output`;
  }
  return `an unknown value in $${variable}`;
};

// Each row of the README's table, once per environment it names, or once
// for the repository when it names none.
const listed = [
  ...readme.matchAll(
    /^\| `([A-Z_]+)` \| (Secret|Variable) \| ([^|]+) \| ([^|]+) \|$/gmu,
  ),
].flatMap(([, name = "", kind = "", environments = "", value = ""]) => {
  const named = [...environments.matchAll(/`([a-z]+)`/gu)].map(
    ([, environment = ""]) => environment,
  );
  return (named.length > 0 ? named : ["repository"]).map(
    (environment) =>
      `${kind.toLowerCase()} ${name} ${environment}: ${value.trim()}`,
  );
});

// Each value the script gives GitHub, and what it is.
const given = lines.flatMap((line) => {
  const [, kind, name, environment, variable] =
    /^give (secret|variable) ([A-Z_]+) ([a-z]+) "\$(\w+)"$/u.exec(line) ?? [];
  return kind && name && environment && variable
    ? [`${kind} ${name} ${environment}: ${describeValue(variable)}`]
    : [];
});

describe("the bootstrap script", () => {
  it("finds the README's table", () => {
    expect(listed.length).toBeGreaterThan(0);
  });

  it("gives GitHub each value the README lists, from the source it names, and nothing else", () => {
    expect([...given].sort()).toEqual([...listed].sort());
  });

  it("gives GitHub nothing through a line the check above cannot read", () => {
    const gives = lines.filter((line) => /^give\s/u.test(line));
    expect(gives).toHaveLength(given.length);
  });

  it("reads only outputs its templates declare", () => {
    expect(reads.size).toBeGreaterThan(0);
    for (const { stack, key } of reads.values()) {
      const file = templates.get(stack);
      expect(file, `no template deployed as $${stack}`).toBeDefined();
      expect(Object.keys(readTemplate(file ?? "").Outputs ?? {})).toContain(
        key,
      );
    }
  });

  it("reaches GitHub only through give, which pipes the value to gh, and drop", () => {
    const gh = lines.filter((line) => /(^|[|;&(`]\s*)gh\b/u.test(line));
    expect(gh).toEqual([
      `printf '%s' "$4" | gh "$1" set "$2" --repo "$REPO"`,
      `printf '%s' "$4" | gh "$1" set "$2" --repo "$REPO" --env "$3"`,
      `if ! err=$(gh "$1" delete "$2" --repo "$REPO" --env "$3" 2>&1 >/dev/null); then`,
    ]);
  });

  // GitHub holds only the role each job assumes (#43). The conformance
  // job names no environment, so its role is the repository's (#50). The
  // values earlier runs set are removed, and none of them is one the
  // script still gives.
  it("gives GitHub one value per environment and one for the repository, and removes the five it no longer sets", () => {
    expect([...given].map((value) => value.split(":")[0]).sort()).toEqual([
      "secret AWS_CONFORMANCE_ROLE_ARN repository",
      "secret AWS_DEPLOY_ROLE_ARN prod",
      "secret AWS_EVAL_ROLE_ARN eval",
    ]);
    const dropped = lines.flatMap((line) => {
      const [, kind, name, environment] =
        /^drop (secret|variable) ([A-Z_]+) ([a-z]+)$/u.exec(line) ?? [];
      return kind && name && environment
        ? [`${kind} ${name} ${environment}`]
        : [];
    });
    expect(dropped.sort()).toEqual([
      "secret AWS_DEPLOY_EXECUTION_ROLE_ARN prod",
      "secret CERTIFICATE_ARN prod",
      "secret PRIVATE_BUCKET_NAME eval",
      "secret PRIVATE_BUCKET_NAME prod",
      "variable HOSTED_ZONE_ID prod",
    ]);
    expect(lines.filter((line) => /^drop\s/u.test(line))).toHaveLength(
      dropped.length,
    );
  });

  // So a session that runs out part way, or an output that is missing,
  // stops the script before GitHub changes.
  it("reads and checks every value before giving GitHub any", () => {
    const check = index(/^for name in [\w ]+; do$/u);
    expect(check).toBeGreaterThan(-1);
    const checked = (lines[check] ?? "")
      .replace("; do", "")
      .split(" ")
      .slice(3);
    expect([...checked].sort()).toEqual([...reads.keys()].sort());
    expect(lines[check + 1]).toBe("case ${!name} in");
    expect(lines[check + 2]).toMatch(/^"" \| None\) .*exit 1 ;;$/u);
    const lastRead = lines.findLastIndex((line) => line.includes("$(output "));
    expect(lastRead).toBeLessThan(check);
    expect(check).toBeLessThan(index(/^give /u));
  });

  it("applies both stacks in us-east-1 under fixed names", () => {
    expect(script).toMatch(/^REGION=us-east-1$/mu);
    // The script sets no default region, so each regional call names it.
    const regional = lines.filter((line) =>
      /\baws (cloudformation|ssm) /u.test(line),
    );
    expect(regional.length).toBeGreaterThan(0);
    for (const line of regional) {
      expect(line).toContain('--region "$REGION"');
    }
    // The name the DNS stack was first applied under, by hand.
    expect(script).toMatch(/^DNS_STACK=dns$/mu);
    expect(script).toMatch(/^ROLES_STACK=grantlink-github-oidc$/mu);
    expect([...templates]).toEqual([
      ["DNS_STACK", "infra/dns.cfn.yml"],
      ["ROLES_STACK", "infra/github-oidc.cfn.yml"],
    ]);
  });

  // However the owner comes by admin credentials for grantlink's account,
  // the script uses them as they are.
  it("uses the credentials it is run with", () => {
    expect(script).toMatch(/^account=\$\(aws sts get-caller-identity /mu);
    for (const route of [
      "organizations",
      "assume-role",
      "OrganizationAccountAccessRole",
      "AWS_ACCESS_KEY_ID",
      "AWS_PROFILE",
      "--profile",
      "export AWS_",
    ]) {
      expect(script).not.toContain(route);
    }
  });

  // A deploy with nothing to change exits non-zero unless told not to, and
  // CloudFormation refuses to update a stack mid-change, so each deploy
  // first waits for its stack to settle.
  it("can run again over stacks that exist or are still changing", () => {
    const deploys = lines.filter((line) =>
      line.startsWith("aws cloudformation deploy "),
    );
    expect(deploys).toHaveLength(2);
    for (const [stack] of templates) {
      const deploy = index(
        new RegExp(
          `^aws cloudformation deploy .*--stack-name "\\$${stack}"`,
          "u",
        ),
      );
      expect(lines[deploy]).toContain("--no-fail-on-empty-changeset");
      expect(lines[deploy - 1]).toBe(`settle "$${stack}"`);
    }
  });

  // A zone kept from an earlier stack has the same name as the new one.
  it("prints the nameservers of the zone its own stack made", () => {
    expect(
      index(
        /describe-stack-resource .*--stack-name "\$DNS_STACK" --logical-resource-id HostedZone /u,
      ),
    ).toBeGreaterThan(-1);
    expect(
      readTemplate(templates.get("DNS_STACK") ?? "").Resources.HostedZone?.Type,
    ).toBe("AWS::Route53::HostedZone");
    expect(
      index(
        /^aws route53 get-hosted-zone --id "\$1" --query 'DelegationSet\.NameServers'/u,
      ),
    ).toBeGreaterThan(-1);
    expect(script).not.toMatch(/list-hosted-zones-by-name/u);
  });

  it("asks for no value by hand but the go-ahead", () => {
    const reading = lines.filter((line) =>
      /(^|[|;&]\s*)(read|select)\b/u.test(line),
    );
    expect(reading).toHaveLength(1);
    expect(reading[0]).toMatch(/^read -r -p /u);
  });
});
