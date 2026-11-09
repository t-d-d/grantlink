import {
  GetBucketEncryptionCommand,
  GetPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// Reads the deployed funding text bucket, since a setting changed in the
// console does not show in the template (storage.md). TEXT_BUCKET is the
// bucket's name, which carries the account id, so it comes from the
// environment and never from the repo.
const { TEXT_BUCKET } = z
  .object({ TEXT_BUCKET: z.string().regex(/^grantlink-text-\d{12}$/u) })
  .parse(process.env);
const s3 = new S3Client({ region: "eu-west-2" });

describe("fitness: the bucket stays private (storage.md)", () => {
  it("blocks all public access", async () => {
    const reply = await s3.send(
      new GetPublicAccessBlockCommand({ Bucket: TEXT_BUCKET }),
    );
    expect(reply.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
  });

  it("is encrypted", async () => {
    const reply = await s3.send(
      new GetBucketEncryptionCommand({ Bucket: TEXT_BUCKET }),
    );
    const rules = reply.ServerSideEncryptionConfiguration?.Rules ?? [];
    expect(
      rules.map(
        (rule) => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
      ),
    ).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(?:AES256|aws:kms)$/u)]),
    );
  });
});
