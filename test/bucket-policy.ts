import { z } from "zod";

const Statement = z.record(z.string(), z.unknown());

// A bucket policy as S3 returns it. A policy written outside CloudFormation
// may hold one statement rather than a list.
export const BucketPolicy = z.object({
  Statement: z
    .union([z.array(Statement), Statement])
    .transform((statement) =>
      Array.isArray(statement) ? statement : [statement],
    )
    .default([]),
});

// Every statement in a policy that is not a Deny, named by its Sid or, if
// it has none, by its place in the list. The private bucket's own policy
// only denies, so any grant here was added outside the template (#67). A
// statement with no Effect, or one S3 would not read as Deny, counts.
export function grantsInPolicy(policy: string): string[] {
  return BucketPolicy.parse(JSON.parse(policy))
    .Statement.map((statement, index) => ({ statement, index }))
    .filter(({ statement }) => statement.Effect !== "Deny")
    .map(({ statement, index }) =>
      typeof statement.Sid === "string" && statement.Sid !== ""
        ? statement.Sid
        : `statement ${String(index + 1)}`,
    );
}
