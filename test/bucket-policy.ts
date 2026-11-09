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

const isWildcardPrincipal = (principal: unknown): boolean =>
  principal === "*" ||
  (typeof principal === "object" &&
    principal !== null &&
    "AWS" in principal &&
    list(principal.AWS).includes("*"));

// A condition that tests plain HTTP and nothing else. Any other operator,
// or another key in the Bool, is ANDed with it and narrows the Deny, so
// the strict objects refuse them.
const OnlySecureTransport = z.strictObject({
  Bool: z.strictObject({ "aws:SecureTransport": z.unknown() }),
});

// Whether the policy holds a Deny, for everyone and every S3 action, on
// both the bucket and its objects, when a request comes over plain HTTP.
// That is the template's HttpsOnly statement. It is looked for by what it
// does, not by its Sid, so a renamed copy passes and a narrowed one fails
// (#135).
export function refusesPlainHttp(
  document: unknown,
  bucketArn: string,
): boolean {
  return BucketPolicy.parse(document).Statement.some((statement) => {
    const actions = list(statement.Action);
    const resources = list(statement.Resource);
    const condition = OnlySecureTransport.safeParse(statement.Condition);
    return (
      statement.Effect === "Deny" &&
      isWildcardPrincipal(statement.Principal) &&
      (actions.includes("s3:*") || actions.includes("*")) &&
      resources.includes(bucketArn) &&
      resources.includes(`${bucketArn}/*`) &&
      // Only a lowercase "false" counts (#168). AWS says the case of a
      // condition value matters or not by its operator, and lists Bool as
      // "Boolean matching" against "true" or "false", with no word that it
      // ignores case. So "FALSE" or "False" fails here, which errs toward
      // failing a policy that does refuse plain HTTP, never toward passing
      // one that does not. See the Condition element page,
      // https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition.html,
      // and the Boolean condition operators on
      // https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition_operators.html#Conditions_Boolean
      condition.success &&
      list(condition.data.Bool["aws:SecureTransport"]).includes("false")
    );
  });
}
