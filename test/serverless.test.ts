import { describe, expect, it } from "vitest";
import { mergeOver, unreadResources } from "./serverless.ts";

const TEMPLATES = ["infra/site.cfn.yml", "infra/data.cfn.yml"];
const known = TEMPLATES.map((path) => `\${file(./${path})}`);

describe("merging serverless.yml's resources as osls does (#142)", () => {
  it("merges objects key by key, so an inline entry changes one property of a template's resource", () => {
    const merged = mergeOver(
      {
        Resources: {
          SiteBucket: {
            Type: "AWS::S3::Bucket",
            Properties: {
              OwnershipControls: {
                Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
              },
              BucketEncryption: { kept: true },
            },
          },
        },
      },
      {
        Resources: {
          SiteBucket: {
            Properties: {
              OwnershipControls: {
                Rules: [{ ObjectOwnership: "ObjectWriter" }],
              },
            },
          },
        },
      },
    );
    expect(merged).toEqual({
      Resources: {
        SiteBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            OwnershipControls: { Rules: [{ ObjectOwnership: "ObjectWriter" }] },
            BucketEncryption: { kept: true },
          },
        },
      },
    });
  });

  it("merges lists item by item, and keeps the target's later items", () => {
    expect(mergeOver({ a: [{ x: 1 }, 2, 3] }, { a: [{ y: 4 }, 5] })).toEqual({
      a: [{ x: 1, y: 4 }, 5, 3],
    });
  });

  it("leaves both of its inputs as they were", () => {
    const target = { a: { b: 1 } };
    const source = { a: { c: 2 } };
    mergeOver(target, source);
    expect(target).toEqual({ a: { b: 1 } });
    expect(source).toEqual({ a: { c: 2 } });
  });
});

describe("what serverless.yml's resources hold that the static checks do not read (#142)", () => {
  it("finds nothing in the two templates, a parameters entry and inline resources", () => {
    expect(
      unreadResources(
        [
          ...known,
          { Parameters: { A: { Default: "x" } } },
          { Resources: { R: { Type: "T" } }, Outputs: { O: { Value: 1 } } },
        ],
        TEMPLATES,
      ),
    ).toEqual([]);
  });

  it("finds a policy added to FirstRunRole through extensions", () => {
    const extension = {
      extensions: {
        FirstRunRole: {
          Properties: {
            Policies: [{ PolicyName: "read", PolicyDocument: {} }],
          },
        },
      },
    };
    expect(unreadResources([...known, extension], TEMPLATES)).toEqual([
      "entry 3 has extensions",
    ]);
    expect(
      unreadResources([...known, { Resources: {}, ...extension }], TEMPLATES),
    ).toEqual(["entry 3 has extensions"]);
  });

  it("finds a third template", () => {
    expect(
      unreadResources([...known, "${file(./infra/more.cfn.yml)}"], TEMPLATES),
    ).toEqual(["entry 3 is ${file(./infra/more.cfn.yml)}"]);
  });

  it("finds a known template listed twice", () => {
    expect(unreadResources([...known, known[0]], TEMPLATES)).toEqual([
      "entry 3 is ${file(./infra/site.cfn.yml)} again",
    ]);
  });

  // osls merges the list in order, so an inline entry listed before a
  // template would sit under it, while test/app.ts merges it over it.
  it("finds an inline entry listed before the templates", () => {
    expect(
      unreadResources([{ Resources: {} }, known[0], known[1]], TEMPLATES),
    ).toEqual([
      "entry 1 is not ${file(./infra/site.cfn.yml)}",
      "entry 2 is not ${file(./infra/data.cfn.yml)}",
      "entry 3 is ${file(./infra/data.cfn.yml)} again",
    ]);
  });

  it("finds the templates out of order or missing", () => {
    expect(unreadResources([known[1], known[0]], TEMPLATES)).toEqual([
      "entry 1 is not ${file(./infra/site.cfn.yml)}",
      "entry 2 is not ${file(./infra/data.cfn.yml)}",
    ]);
    expect(unreadResources([known[0]], TEMPLATES)).toEqual([
      "entry 2 is not ${file(./infra/data.cfn.yml)}",
    ]);
  });

  it("finds any other key, such as Conditions or Transform", () => {
    expect(
      unreadResources(
        [...known, { Conditions: {} }, { Transform: "AWS::Serverless" }],
        TEMPLATES,
      ),
    ).toEqual(["entry 3 has Conditions", "entry 4 has Transform"]);
  });

  it("finds resources that are not a list, which osls reads as one entry", () => {
    expect(unreadResources({ Resources: {} }, TEMPLATES)).toEqual([
      "resources is not a list",
    ]);
  });
});
