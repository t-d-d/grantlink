import { describe, expect, it } from "vitest";
import { parseTemplate } from "./cfn.ts";

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
