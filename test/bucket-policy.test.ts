import { describe, expect, it } from "vitest";
import { grantsInPolicy } from "./bucket-policy.ts";

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
