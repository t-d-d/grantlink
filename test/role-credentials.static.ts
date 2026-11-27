import { describe, expect, it } from "vitest";
import {
  ASSUME_ROLE,
  ASSUME_ROLE_FILE,
  assumeRole,
  conformanceWorkflow,
  deploy,
  evalWorkflow,
  type Step,
  type Workflow,
} from "./app.ts";
import { readRepoFile } from "./repo.ts";

// The deploy, eval and conformance roles' credentials go only to the steps
// that call AWS, as step env, so code those steps do not run never holds
// them (#259, #308, #349). Each assumes its role through one local action,
// so the script that masks the token and the credentials is written once
// (#114). test/deploy.static.ts keeps what is particular to the deploy.
// The tests match the credentials by the assume step's outputs, as no test
// in the gate names a key (code-and-tests.md).
const credential = /steps\.assume\.outputs\.(key|secret|session)\b/u;

interface Role {
  title: string;
  workflow: Workflow;
  job: string;
  role: string;
  // The secret that holds the role's ARN, and the session's name before
  // the run id.
  secret: string;
  session: string;
  callers: string[];
  // The variable that names the private bucket, and the steps that read
  // it. The deploy's role writes no bucket.
  bucket?: { name: string; to: string[] };
}

const roles: Role[] = [
  {
    title: "the deploy role's credentials",
    workflow: deploy,
    job: "deploy",
    role: "Assume the deploy role",
    secret: "AWS_DEPLOY_ROLE_ARN",
    session: "grantlink-deploy",
    callers: [
      "Check the app stack",
      "Keep the first run's time",
      "Deploy the app stack",
      "Read the stack's outputs",
      "Publish the page",
    ],
  },
  {
    title: "the eval role's credentials",
    workflow: evalWorkflow,
    job: "eval",
    role: "Assume the eval role",
    secret: "AWS_EVAL_ROLE_ARN",
    session: "grantlink-eval",
    callers: [
      "Look for the report filed for this fingerprint",
      "Download the snapshot",
      "File the report",
    ],
    // The script finds the bucket from the account it is in.
    bucket: {
      name: "BUCKET",
      to: ["Look for the report filed for this fingerprint", "File the report"],
    },
  },
  {
    title: "the conformance role's credentials",
    workflow: conformanceWorkflow,
    job: "conformance",
    role: "Assume the conformance role",
    secret: "AWS_CONFORMANCE_ROLE_ARN",
    session: "grantlink-conformance",
    callers: ["Run the conformance tests"],
    bucket: { name: "TEXT_BUCKET", to: ["Run the conformance tests"] },
  },
];

describe.each(roles)(
  "$title",
  ({ workflow, job, role, secret, session, callers, bucket }) => {
    const all: Step[] = workflow.jobs[job]?.steps ?? [];
    const assume = all.find((step) => step.name === role);
    const credentials = (step: Step): string[] =>
      Object.values(step.env ?? {}).filter((value) => credential.test(value));
    const given = all.filter((step) => credentials(step).length > 0);

    it("come from the shared action, given the role's secret and a session name", () => {
      expect(assume?.id).toBe("assume");
      expect(assume?.uses).toBe(ASSUME_ROLE);
      expect(assume?.run).toBeUndefined();
      expect(assume?.with).toEqual({
        role: `\${{ secrets.${secret} }}`,
        "secret-name": secret,
        "session-name": session,
      });
    });

    // A local action is read from the job's workspace, so the job must
    // check the repository out before the step that uses it.
    it("come from the action only once the repository is checked out", () => {
      const checkedOut = all.findIndex((step) =>
        (step.uses ?? "").startsWith("actions/checkout@"),
      );
      expect(checkedOut).toBeGreaterThan(-1);
      expect(checkedOut).toBeLessThan(all.indexOf(assume ?? {}));
    });

    it("are written nowhere through GITHUB_ENV", () => {
      expect(JSON.stringify(workflow)).not.toContain("GITHUB_ENV");
    });

    it("go only to the steps that call AWS", () => {
      expect(given.map((step) => step.name)).toEqual(callers);
    });

    it("go whole to each of those steps", () => {
      for (const step of given) {
        expect(credentials(step).sort()).toEqual([
          "${{ steps.assume.outputs.key }}",
          "${{ steps.assume.outputs.secret }}",
          "${{ steps.assume.outputs.session }}",
        ]);
      }
    });

    // Each output goes to the variable for its part of the credentials, told
    // apart by a word in the variable's name, so no two are swapped.
    it("go each to the variable for its part", () => {
      const parts: Record<string, string> = {
        key: "KEY_ID",
        secret: "SECRET",
        session: "SESSION",
      };
      for (const step of given) {
        for (const [name, value] of Object.entries(step.env ?? {})) {
          const part = credential.exec(value)?.[1];
          if (part === undefined) continue;
          expect(name).toContain(parts[part]);
        }
      }
    });

    // The bucket's name carries the account id, which the step masks. Any
    // variable that reads it counts, not only the one the steps expect.
    it("hand the bucket's name only to the steps that read it", () => {
      const named = all.filter((step) =>
        Object.values(step.env ?? {}).some((value) =>
          value.includes("steps.assume.outputs.bucket"),
        ),
      );
      expect(named.map((step) => step.name)).toEqual(bucket?.to ?? []);
      for (const step of named) {
        expect(step.env?.[bucket?.name ?? ""], step.name).toBe(
          "${{ steps.assume.outputs.bucket }}",
        );
      }
    });

    // The tests above count only key, secret, session and the bucket, so any
    // other output a step reads, such as the account id, would pass them.
    it("hand on no other output of the assume step", () => {
      const allowed = ["key", "secret", "session"];
      if (bucket !== undefined) allowed.push("bucket");
      const read = all.flatMap((step) =>
        Object.values(step.env ?? {}).flatMap((value) =>
          [...value.matchAll(/steps\.assume\.outputs\.(\w+)/gu)].map(
            ([, name]) => name,
          ),
        ),
      );
      expect(read.filter((name) => !allowed.includes(name ?? ""))).toEqual([]);
    });

    it("are read nowhere but in those steps' env", () => {
      const rest = {
        ...workflow,
        jobs: {
          ...workflow.jobs,
          [job]: {
            ...workflow.jobs[job],
            steps: all.map((step) => ({ ...step, env: {} })),
          },
        },
      };
      expect(JSON.stringify(rest)).not.toContain("steps.assume.outputs");
    });
  },
);

// The action's one step assumes the role. The workflows' tests above read
// how its outputs are handed on, and test/workflow-steps.int.ts runs it.
describe("the shared action that assumes a role", () => {
  const steps = assumeRole.runs.steps ?? [];
  const step = steps[0];
  const run = step?.run ?? "";

  it("is a composite action with one bash step", () => {
    expect(assumeRole.runs.using).toBe("composite");
    expect(steps).toHaveLength(1);
    expect(step?.id).toBe("assume");
    expect(step?.shell).toBe("bash");
  });

  // An input reaches the script through env, so no value is pasted into
  // the script's text where the shell would read it as code.
  it("reads its inputs through env alone", () => {
    expect(Object.keys(assumeRole.inputs ?? {}).sort()).toEqual([
      "role",
      "secret-name",
      "session-name",
    ]);
    expect(step?.env).toEqual({
      ROLE: "${{ inputs.role }}",
      SECRET_NAME: "${{ inputs.secret-name }}",
      SESSION_NAME: "${{ inputs.session-name }}",
    });
    expect(run).not.toContain("${{");
  });

  it("stops on the first error and never traces the shell", () => {
    expect(run).toMatch(/^set -euo pipefail$/mu);
    expect(readRepoFile(ASSUME_ROLE_FILE)).not.toMatch(/\bset -x\b/u);
  });

  it("masks the account id, the token and the credentials before it writes anything", () => {
    const written = run.indexOf("GITHUB_OUTPUT");
    expect(written).toBeGreaterThan(-1);
    for (const name of ["token", "account", "key", "secret", "session"]) {
      const mask = run.indexOf(`::add-mask::$${name}"`);
      expect(mask, name).toBeGreaterThan(-1);
      expect(mask, name).toBeLessThan(written);
    }
    expect(run).not.toContain("GITHUB_ENV");
  });

  // The OIDC token is masked before the step hands it to STS, so no line
  // that could print it comes first.
  it("masks the OIDC token before it calls STS", () => {
    const mask = run.indexOf('::add-mask::$token"');
    expect(mask).toBeGreaterThan(-1);
    expect(mask).toBeLessThan(run.indexOf("assume-role-with-web-identity"));
  });

  // The private bucket is grantlink-text-<account id>, as the app stack
  // names it (#43). The id is masked before the name is built from it or
  // written where a later step could print it.
  it("builds the bucket's name only once the account is masked", () => {
    const built = run.indexOf('echo "bucket=grantlink-text-$account"');
    const mask = run.indexOf('::add-mask::$account"');
    expect(mask).toBeGreaterThan(-1);
    expect(built).toBeGreaterThan(mask);
    expect(run.indexOf("GITHUB_OUTPUT", built)).toBeGreaterThan(built);
  });

  // The workflows read the outputs by name, so a misspelt one would hand
  // them an empty value that no other test in the gate sees.
  it("hands on the credentials and the bucket's name under the names the workflows read", () => {
    const names = ["key", "secret", "session", "bucket"];
    expect(Object.keys(assumeRole.outputs ?? {}).sort()).toEqual(
      [...names].sort(),
    );
    for (const name of names) {
      expect(assumeRole.outputs?.[name]?.value, name).toBe(
        `\${{ steps.assume.outputs.${name} }}`,
      );
    }
    for (const name of ["key", "secret", "session"]) {
      expect(run, name).toContain(`echo "${name}=$${name}"`);
    }
  });
});
