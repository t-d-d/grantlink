import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { report, verdict } from "../../evals/report.ts";

// The release record (docs/constraints/deploy-gates.md): which commit is
// live, the eval's fingerprint for it, the report that covers it with the
// run that produced it, and the run that deployed it. The deploy writes it
// as site/release.json, which ships with the function and the page. It
// holds scores and links only.
//
//   node src/page/release.ts <report.json> <release.json>
//
// reads COMMIT, FINGERPRINT and DEPLOY_RUN_URL, and refuses a report for
// another fingerprint or below a gating floor.

const HEX = (length: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${String(length)}}$`, "u"));

export const release = z
  .object({
    commit: HEX(40),
    fingerprint: HEX(64),
    deployRunUrl: z
      .url({ protocol: /^https$/u })
      .regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+/u),
    report,
  })
  .strict()
  .refine((given) => given.report.fingerprint === given.fingerprint, {
    message: "the report was filed for another fingerprint",
  });

export type Release = z.infer<typeof release>;

export function makeRelease(fields: Release): Release {
  const parsed = release.parse(fields);
  if (!verdict(parsed.report).releasable) {
    throw new Error("the report is below a gating floor");
  }
  return parsed;
}

const env = z.object({
  COMMIT: z.string(),
  FINGERPRINT: z.string(),
  DEPLOY_RUN_URL: z.string(),
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [from, to] = process.argv.slice(2);
  if (from === undefined || to === undefined) {
    throw new Error(
      "usage: node src/page/release.ts <report.json> <release.json>",
    );
  }
  const { COMMIT, FINGERPRINT, DEPLOY_RUN_URL } = env.parse(process.env);
  const made = makeRelease({
    commit: COMMIT,
    fingerprint: FINGERPRINT,
    deployRunUrl: DEPLOY_RUN_URL,
    report: report.parse(JSON.parse(readFileSync(from, "utf8"))),
  });
  writeFileSync(to, `${JSON.stringify(made)}\n`);
}
