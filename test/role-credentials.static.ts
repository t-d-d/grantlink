import { describe, expect, it } from "vitest";
import {
  conformanceWorkflow,
  evalWorkflow,
  type Step,
  type Workflow,
} from "./app.ts";

// The eval and conformance roles' credentials go only to the steps that
// call AWS, as step env, so code those steps do not run never holds them.
// The deploy does the same, which test/deploy.static.ts holds (#259, #308).
// The tests match the credentials by the assume step's outputs, as no test
// in the gate names a key (code-and-tests.md).
const credential = /steps\.assume\.outputs\.(key|secret|session)\b/u;

describe.each([
  {
    title: "the eval role's credentials",
    workflow: evalWorkflow,
    job: "eval",
    role: "Assume the eval role",
    bucket: "BUCKET",
    callers: [
      "Look for the report filed for this fingerprint",
      "Download the snapshot",
      "File the report",
    ],
    // The script finds the bucket from the account it is in.
    bucketTo: [
      "Look for the report filed for this fingerprint",
      "File the report",
    ],
  },
  {
    title: "the conformance role's credentials",
    workflow: conformanceWorkflow,
    job: "conformance",
    role: "Assume the conformance role",
    bucket: "TEXT_BUCKET",
    callers: ["Run the conformance tests"],
    bucketTo: ["Run the conformance tests"],
  },
])("$title", ({ workflow, job, role, bucket, callers, bucketTo }) => {
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

  // The bucket's name carries the account id, which the step masks.
  it("hand the bucket's name only to the steps that read it", () => {
    const named = all.filter(
      (step) => step.env?.[bucket] === "${{ steps.assume.outputs.bucket }}",
    );
    expect(named.map((step) => step.name)).toEqual(bucketTo);
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
