import { describe, expect, it } from "vitest";
import { grantsInPolicy, refusesPlainHttp } from "./bucket-policy.ts";

describe("grantsInPolicy", () => {
  it("passes a policy whose statements all deny", () => {
    expect(
      grantsInPolicy({
        Version: "2012-10-17",
        Statement: [
          { Sid: "HttpsOnly", Effect: "Deny", Action: "s3:*" },
          {
            Sid: "WriteOnceUnderEval",
            Effect: "Deny",
            Action: "s3:PutObject",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("names each statement that does not deny", () => {
    expect(
      grantsInPolicy({
        Statement: [
          { Sid: "HttpsOnly", Effect: "Deny" },
          { Sid: "Added", Effect: "Allow", Action: "s3:GetObject" },
          { Effect: "Allow", Action: "s3:*" },
        ],
      }),
    ).toEqual(["Added", "statement 3"]);
  });

  it("reads a lone statement that is not in a list", () => {
    expect(
      grantsInPolicy({ Statement: { Sid: "Added", Effect: "Allow" } }),
    ).toEqual(["Added"]);
  });

  it("counts a statement with no Effect, or an Effect in another case, as a grant", () => {
    expect(
      grantsInPolicy({
        Statement: [{ Sid: "NoEffect" }, { Sid: "Lower", Effect: "deny" }],
      }),
    ).toEqual(["NoEffect", "Lower"]);
  });

  it("refuses a policy with no statements rather than pass it", () => {
    expect(() => grantsInPolicy({})).toThrow();
  });
});

describe("refusesPlainHttp", () => {
  const bucket = "arn:aws:s3:::grantlink-text-example";
  const httpsOnly = {
    Sid: "HttpsOnly",
    Effect: "Deny",
    Principal: "*",
    Action: "s3:*",
    Resource: [bucket, `${bucket}/*`],
    Condition: { Bool: { "aws:SecureTransport": "false" } },
  };
  const others = { Sid: "Other", Effect: "Deny", Action: "s3:PutObject" };

  it("passes a policy that denies plain HTTP on the bucket and its objects", () => {
    expect(refusesPlainHttp({ Statement: [others, httpsOnly] }, bucket)).toBe(
      true,
    );
  });

  it("reads a lone statement, and a condition value in a list", () => {
    expect(
      refusesPlainHttp(
        {
          Statement: {
            ...httpsOnly,
            Principal: { AWS: "*" },
            Action: ["*"],
            Condition: { Bool: { "aws:SecureTransport": ["false"] } },
          },
        },
        bucket,
      ),
    ).toBe(true);
  });

  it("reads an unquoted false, as YAML parses it, as plain HTTP", () => {
    expect(
      refusesPlainHttp(
        {
          Statement: [
            {
              ...httpsOnly,
              Condition: { Bool: { "aws:SecureTransport": false } },
            },
          ],
        },
        bucket,
      ),
    ).toBe(true);
  });

  it("fails a policy with the statement removed", () => {
    expect(refusesPlainHttp({ Statement: [others] }, bucket)).toBe(false);
  });

  it.each([
    ["it allows rather than denies", { Effect: "Allow" }],
    [
      "it denies only some callers",
      { Principal: { Service: "cloudfront.amazonaws.com" } },
    ],
    ["it denies only some actions", { Action: "s3:GetObject" }],
    ["it leaves out the objects", { Resource: bucket }],
    ["it leaves out the bucket", { Resource: `${bucket}/*` }],
    [
      "it names another bucket",
      { Resource: ["arn:aws:s3:::other", "arn:aws:s3:::other/*"] },
    ],
    [
      "it denies HTTPS instead",
      { Condition: { Bool: { "aws:SecureTransport": "true" } } },
    ],
    [
      "it denies an unquoted true instead",
      { Condition: { Bool: { "aws:SecureTransport": true } } },
    ],
    ["it has no condition", { Condition: undefined }],
    [
      "another condition narrows it",
      {
        Condition: {
          Bool: { "aws:SecureTransport": "false" },
          IpAddress: { "aws:SourceIp": "192.0.2.0/24" },
        },
      },
    ],
    [
      "another key in its Bool narrows it",
      {
        Condition: {
          Bool: {
            "aws:SecureTransport": "false",
            "aws:ViaAWSService": "false",
          },
        },
      },
    ],
  ])("fails when %s", (_, change) => {
    expect(
      refusesPlainHttp({ Statement: [{ ...httpsOnly, ...change }] }, bucket),
    ).toBe(false);
  });
});
