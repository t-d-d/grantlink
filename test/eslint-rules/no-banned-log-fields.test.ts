import { afterAll, describe, it } from "vitest";
import { noBannedLogFields } from "../../eslint-rules/no-banned-log-fields.ts";
import { ruleTester } from "../rule-tester.ts";

const tester = ruleTester({ afterAll, describe, it });

describe("fitness: no text in logs (personal-data.md)", () => {
  tester.run("no-banned-log-fields", noBannedLogFields, {
    valid: [
      {
        name: "logs ids and counts",
        code: `logger.info("paper-processed", { pmcid, references: 2, stepName });
          console.error("run-failed", { runId, errorClass: "transient" });`,
      },
      {
        name: "is not a logger",
        code: `catalog.info("x", { fundingText });`,
      },
    ],
    invalid: [
      {
        name: "logs the funding text",
        code: `logger.info("paper-processed", { pmcid, fundingText });`,
        errors: [{ messageId: "bannedField" }],
      },
      {
        name: "logs acknowledgements through a child logger",
        code: `const log = logger.child({ acknowledgements: paper.acknowledgements });`,
        errors: [{ messageId: "bannedField" }],
      },
      {
        name: "logs a name under an innocent key",
        code: `runLog.warn("odd-reference", { detail: paper.authorNames });`,
        errors: [{ messageId: "bannedValue" }],
      },
      {
        name: "logs a statement passed bare",
        code: `console.log(statement);`,
        errors: [{ messageId: "bannedValue" }],
      },
    ],
  });
});
