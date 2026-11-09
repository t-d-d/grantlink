import { afterAll, describe, it } from "vitest";
import { onlyOwnerImports } from "../../eslint-rules/only-owner-imports.ts";
import { ruleTester } from "../rule-tester.ts";

const tester = ruleTester({ afterAll, describe, it });

const options = [
  {
    owners: [
      {
        owner: "src/store/table.ts",
        modules: ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb"],
      },
      { owner: "src/store/bucket.ts", modules: ["@aws-sdk/client-s3"] },
    ],
  },
] as const;

describe("fitness: one way in to each store (storage.md)", () => {
  tester.run("only-owner-imports", onlyOwnerImports, {
    valid: [
      {
        name: "the table module imports DynamoDB",
        filename: "src/store/table.ts",
        code: `import { DynamoDBClient } from "@aws-sdk/client-dynamodb";`,
        options,
      },
      {
        name: "the bucket module imports S3",
        filename: "src/store/bucket.ts",
        code: `import { S3Client } from "@aws-sdk/client-s3";`,
        options,
      },
      {
        name: "a run imports the table module",
        filename: "src/run/handler.ts",
        code: `import { putPaper } from "../store/table.ts";`,
        options,
      },
    ],
    invalid: [
      {
        name: "a run imports DynamoDB itself",
        filename: "src/run/handler.ts",
        code: `import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";`,
        options,
        errors: [{ messageId: "notOwner" }],
      },
      {
        name: "the table module imports S3",
        filename: "src/store/table.ts",
        code: `export { S3Client } from "@aws-sdk/client-s3";`,
        options,
        errors: [{ messageId: "notOwner" }],
      },
      {
        name: "a module loads S3 at run time",
        filename: "src/extract/rules.ts",
        code: `const s3 = await import("@aws-sdk/client-s3");`,
        options,
        errors: [{ messageId: "notOwner" }],
      },
    ],
  });
});
