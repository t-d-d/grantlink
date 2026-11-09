import { describe, expect, it } from "vitest";
import {
  parseTemplate,
  patternWithin,
  patternsOverlap,
  renderArn,
} from "./cfn.ts";

describe("reading a template's short-form intrinsics", () => {
  it("splits a GetAtt at its first dot only, as CloudFormation does", () => {
    const template = parseTemplate(
      "Resources: {}\nOutputs:\n  A:\n    Value: !GetAtt Db.Endpoint.Address\n",
    );
    expect(template.Outputs?.A?.Value).toEqual({
      "Fn::GetAtt": ["Db", "Endpoint.Address"],
    });
  });
});

describe("comparing IAM patterns", () => {
  it("finds a pattern inside a wider one", () => {
    expect(patternWithin("a:b/c/*", "a:b/*")).toBe(true);
    expect(patternWithin("a:b/c", "a:b/c")).toBe(true);
    expect(patternWithin("log:g:*:*", "log:g:*")).toBe(true);
    expect(patternWithin("a:b/*", "a:b/*")).toBe(true);
  });

  it("lets a ? in the wider pattern take a ? in the narrower", () => {
    expect(patternWithin("a:b?", "a:b?")).toBe(true);
    expect(patternWithin("a:?*", "a:?*")).toBe(true);
    expect(patternWithin("a:b?", "a:b*")).toBe(true);
    expect(patternWithin("a:b*", "a:b?*")).toBe(false);
  });

  it("does not find a pattern inside a narrower one", () => {
    expect(patternWithin("a:b/*", "a:b/c/*")).toBe(false);
    expect(patternWithin("log:g*", "log:g-run")).toBe(false);
    expect(patternWithin("a:b?", "a:bc")).toBe(false);
    expect(patternWithin("a:b*", "a:b?")).toBe(false);
  });

  it("compares ARNs with regard to case", () => {
    expect(patternWithin("s3:::Bucket-x", "s3:::bucket-*")).toBe(false);
  });

  it("finds where two patterns share a value", () => {
    expect(patternsOverlap("a:b/*", "a:*/c")).toBe(true);
    expect(patternsOverlap("a:eval/*", "a:eval-reports/*")).toBe(false);
    expect(patternsOverlap("a:b?", "a:bc")).toBe(true);
    expect(patternsOverlap("a:b", "a:c")).toBe(false);
  });
});

describe("rendering a resource to an ARN", () => {
  const names = {
    "AWS::Partition": "aws",
    "AWS::AccountId": "ACCOUNT",
    "Table.Arn": "arn:aws:dynamodb:eu-west-2:ACCOUNT:table/t",
  };

  it("fills a Sub's variables and a GetAtt's ARN", () => {
    expect(
      renderArn(
        { "Fn::Sub": "arn:${AWS::Partition}:s3:::b-${AWS::AccountId}/*" },
        names,
      ),
    ).toBe("arn:aws:s3:::b-ACCOUNT/*");
    expect(renderArn({ "Fn::GetAtt": ["Table", "Arn"] }, names)).toBe(
      "arn:aws:dynamodb:eu-west-2:ACCOUNT:table/t",
    );
    expect(renderArn({ "Fn::Sub": "${Table.Arn}/x" }, names)).toBe(
      "arn:aws:dynamodb:eu-west-2:ACCOUNT:table/t/x",
    );
  });

  it("refuses a name it does not know", () => {
    expect(() => renderArn({ "Fn::Sub": "${Other.Arn}" }, names)).toThrow(
      "Other.Arn",
    );
    expect(() => renderArn({ Ref: "Other" }, names)).toThrow();
  });
});
