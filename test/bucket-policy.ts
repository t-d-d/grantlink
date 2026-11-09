import { z } from "zod";
import { list } from "./cfn.ts";

const Statement = z.record(z.string(), z.unknown());

// A bucket policy's document, as S3 returns it or as the template writes
// it. Either may hold one statement rather than a list.
export const BucketPolicy = z.object({
  Statement: z
    .union([z.array(Statement), Statement])
    .transform((statement) => list(statement)),
});

// Every statement in a policy that is not a Deny, named by its Sid or, if
// it has none, by its place in the list. The private bucket's policy only
// denies, so a grant here, in the template or added outside it, would hand
// someone its objects (#59, #67). A statement with no Effect, or one S3
// would not read as Deny, counts.
export function grantsInPolicy(document: unknown): string[] {
  return BucketPolicy.parse(document)
    .Statement.map((statement, index) => ({ statement, index }))
    .filter(({ statement }) => statement.Effect !== "Deny")
    .map(({ statement, index }) =>
      typeof statement.Sid === "string" && statement.Sid !== ""
        ? statement.Sid
        : `statement ${String(index + 1)}`,
    );
}
