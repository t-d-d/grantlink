import { describe, expect, it } from "vitest";
import {
  conformanceWorkflow,
  deploy,
  evalWorkflow,
  type Step,
  type Workflow,
} from "./app.ts";

// The deploy, eval and conformance roles' credentials go only to the steps
// that call AWS, as step env, so code those steps do not run never holds
// them (#259, #308, #349). test/deploy.static.ts keeps what is particular
// to the deploy. The tests match the credentials by the assume step's
// outputs, as no test in the gate names a key (code-and-tests.md).
const credential = /steps\.assume\.outputs\.(key|secret|session)\b/u;

interface Role {
  title: string;
  workflow: Workflow;
  job: string;
  role: string;
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
    callers: ["Run the conformance tests"],
    bucket: { name: "TEXT_BUCKET", to: ["Run the conformance tests"] },
  },
];

describe.each(roles)("$title", ({ workflow, job, role, callers, bucket }) => {
  const all: Step[] = workflow.jobs[job]?.steps ?? [];
  const assume = all.find((step) => step.name === role);
  const credentials = (step: Step): string[] =>
    Object.values(step.env ?? {}).filter((value) => credential.test(value));
  const given = all.filter((step) => credentials(step).length > 0);

  it("are handed on as the assume step's outputs, not through GITHUB_ENV", () => {
    expect(assume?.id).toBe("assume");
    expect(assume?.run).toContain('>> "$GITHUB_OUTPUT"');
    expect(JSON.stringify(workflow)).not.toContain("GITHUB_ENV");
  });

  it("are masked before the step writes them out", () => {
    const run = assume?.run ?? "";
    const written = run.indexOf("GITHUB_OUTPUT");
    for (const name of ["key", "secret", "session", "account"]) {
      const mask = run.indexOf(`::add-mask::$${name}"`);
      expect(mask, name).toBeGreaterThan(-1);
      expect(mask, name).toBeLessThan(written);
    }
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

  // The steps read the outputs by name, so a misspelt one would hand them
  // an empty value that no other test in the gate sees.
  it("are written under the names the steps read", () => {
    const run = assume?.run ?? "";
    for (const name of ["key", "secret", "session"]) {
      expect(run, name).toContain(`echo "${name}=$${name}"`);
    }
    if (bucket === undefined) expect(run).not.toContain("bucket=");
    else expect(run).toContain('echo "bucket=grantlink-text-$account"');
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
});
