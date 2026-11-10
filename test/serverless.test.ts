import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseTemplate } from "./cfn.ts";
import {
  mergeKeysIn,
  mergeOver,
  strayVariablesIn,
  unreadResources,
} from "./serverless.ts";

const TEMPLATES = ["infra/site.cfn.yml", "infra/data.cfn.yml"];
const known = TEMPLATES.map((path) => `\${file(./${path})}`);
const stack = { declared: ["SiteBucket", "Distribution"], functions: ["run"] };
const unread = (resources: unknown): string[] =>
  unreadResources(resources, TEMPLATES, stack);

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
      unread([
        ...known,
        { Parameters: { A: { Default: "x" } } },
        { Resources: { R: { Type: "T" } }, Outputs: { O: { Value: 1 } } },
      ]),
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
    expect(unread([...known, extension])).toEqual(["entry 3 has extensions"]);
    expect(unread([...known, { Resources: {}, ...extension }])).toEqual([
      "entry 3 has extensions",
    ]);
  });

  it("finds a third template", () => {
    expect(unread([...known, "${file(./infra/more.cfn.yml)}"])).toEqual([
      "entry 3 is ${file(./infra/more.cfn.yml)}",
    ]);
  });

  it("finds a known template listed twice", () => {
    expect(unread([...known, known[0]])).toEqual([
      "entry 3 is ${file(./infra/site.cfn.yml)} again",
    ]);
  });

  // osls merges the list in order, so an inline entry listed before a
  // template would sit under it, while test/app.ts merges it over it.
  it("finds an inline entry listed before the templates", () => {
    expect(unread([{ Resources: {} }, known[0], known[1]])).toEqual([
      "entry 1 is not ${file(./infra/site.cfn.yml)}",
      "entry 2 is not ${file(./infra/data.cfn.yml)}",
      "entry 3 is ${file(./infra/data.cfn.yml)} again",
    ]);
  });

  it("finds the templates out of order or missing", () => {
    expect(unread([known[1], known[0]])).toEqual([
      "entry 1 is not ${file(./infra/site.cfn.yml)}",
      "entry 2 is not ${file(./infra/data.cfn.yml)}",
    ]);
    expect(unread([known[0]])).toEqual([
      "entry 2 is not ${file(./infra/data.cfn.yml)}",
    ]);
  });

  it("finds any other key, such as Conditions or Transform", () => {
    expect(
      unread([...known, { Conditions: {} }, { Transform: "AWS::Serverless" }]),
    ).toEqual(["entry 3 has Conditions", "entry 4 has Transform"]);
  });

  it("finds resources that are not a list, which osls reads as one entry", () => {
    expect(unread({ Resources: {} })).toEqual(["resources is not a list"]);
  });
});

describe("inline resources that change what a template or osls declares (#166)", () => {
  it("finds an inline entry that changes a template's resource", () => {
    expect(
      unread([
        ...known,
        {
          Resources: {
            Distribution: {
              Properties: {
                DistributionConfig: {
                  DefaultCacheBehavior: { ViewerProtocolPolicy: "allow-all" },
                },
              },
            },
          },
        },
      ]),
    ).toEqual(["entry 3 changes Distribution, which a template declares"]);
  });

  it.each([
    "IamRoleLambdaExecution",
    "RunLambdaFunction",
    "RunLogGroup",
    "RunDurableLambdaAlias",
    "RunLambdaVersionAbc123",
    "ServerlessDeploymentBucket",
    "ServerlessDeploymentBucketPolicy",
    "ApiGatewayRestApi",
    "runSchedule",
    "Base123LambdaLayerPermission",
    "OrdersStreamConsumer",
    "AuthApiGatewayAuthorizer",
    "AuthLambdaAuthorizerPermissionHttpApi",
  ])("finds an inline entry that changes %s, which osls generates", (id) => {
    expect(
      unread([...known, { Resources: { [id]: { Properties: {} } } }]),
    ).toEqual([`entry 3 changes ${id}, which osls generates`]);
  });

  it.each(["ServerlessDeploymentBucketName", "RunLambdaFunctionQualifiedArn"])(
    "finds an inline entry that changes the output %s, which osls generates",
    (id) => {
      expect(unread([...known, { Outputs: { [id]: { Value: 1 } } }])).toEqual([
        `entry 3 changes the output ${id}, which osls generates`,
      ]);
    },
  );

  it.each(["Parameters", "Resources", "Outputs"])(
    "finds %s that is not a map, which osls would merge over the whole section",
    (key) => {
      expect(unread([...known, { [key]: null }, { [key]: [] }])).toEqual([
        `entry 3 has ${key} that is not a map`,
        `entry 4 has ${key} that is not a map`,
      ]);
    },
  );

  it("passes a resource of its own, such as FirstRunRole", () => {
    expect(
      unread([...known, { Resources: { FirstRunRole: { Type: "T" } } }]),
    ).toEqual([]);
  });
});

describe("variables inside inline entries (#166)", () => {
  it("passes the cf and env variables in use, and CloudFormation's own Sub variables", () => {
    expect(
      unread([
        ...known,
        {
          Parameters: {
            A: { Default: "${cf(us-east-1):dns.CertificateArn}" },
          },
          Resources: {
            R: {
              Type: "T",
              Properties: {
                At: "at(${env:FIRST_RUN_AT})",
                Fallback: "${env:X, 'local'}",
                Arn: {
                  "Fn::Sub":
                    "arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/p",
                },
                Bucket: { "Fn::Sub": "${SiteBucket.Arn}/*" },
              },
            },
          },
        },
      ]),
    ).toEqual([]);
  });

  it("finds a file variable inside an inline resource", () => {
    expect(
      unread([
        ...known,
        {
          Resources: {
            R: { Type: "T", Properties: { Policies: "${file(./p.yml)}" } },
          },
        },
      ]),
    ).toEqual([
      "entry 3 has a variable from file at Resources.R.Properties.Policies",
    ]);
  });

  it("finds a variable in a fallback, a parameter or an address", () => {
    expect(
      unread([
        ...known,
        {
          Outputs: {
            A: { Value: "${env:X, file(./a.yml)}" },
            B: { Value: "${cf(${self:region}):dns.Zone}" },
            C: { Value: "${env:${opt:name}}" },
          },
        },
      ]),
    ).toEqual([
      "entry 3 has a variable from file at Outputs.A.Value",
      "entry 3 has a variable from self at Outputs.B.Value",
      "entry 3 has a variable from opt at Outputs.C.Value",
    ]);
  });

  it("finds a variable in a list item or a key", () => {
    expect(
      unread([
        ...known,
        {
          Resources: { R: { Type: "T", Properties: { L: ["${sls:stage}"] } } },
        },
        { Outputs: { "${self:custom.name}": { Value: 1 } } },
      ]),
    ).toEqual([
      "entry 3 has a variable from sls at Resources.R.Properties.L.0",
      "entry 4 has a variable from self at Outputs",
    ]);
  });

  it("finds a variable osls cannot parse", () => {
    expect(
      unread([
        ...known,
        { Outputs: { A: { Value: "${env:X, ${file(./a)}}" } } },
      ]),
    ).toEqual(["entry 3 has a variable osls cannot parse at Outputs.A.Value"]);
  });
});

// osls resolves the variables in a file it reads too, so a template may
// hold none but the cf and env ones (#166).
describe("variables inside a template (#166)", () => {
  it("passes CloudFormation's own Sub variables", () => {
    expect(
      strayVariablesIn({
        Resources: { R: { Properties: { A: { "Fn::Sub": "${R.Arn}/*" } } } },
      }),
    ).toEqual([]);
  });

  it("finds a self variable, with where it sits", () => {
    expect(
      strayVariablesIn({ Outputs: { O: { Value: "${self:custom.x}" } } }),
    ).toEqual(["a variable from self at Outputs.O.Value"]);
  });
});

// osls reads YAML with js-yaml, which applies a merge key, while the static
// checks keep `<<` as an ordinary key. The app uses none, so the gate
// refuses any (#242).
describe("YAML merge keys, which osls applies and the static checks do not (#242)", () => {
  const inline = [
    "resources:",
    "  - Resources:",
    "      Box: { <<: { Type: AWS::EC2::Instance }, Properties: {} }",
  ].join("\n");

  it("finds a resource whose Type comes from a merge key in serverless.yml", () => {
    expect(mergeKeysIn(parse(inline))).toEqual([
      "a merge key at resources.0.Resources.Box",
    ]);
  });

  it("finds a merge key from an alias in a template", () => {
    const template = [
      "Resources:",
      "  Base: &role",
      "    Type: AWS::IAM::Role",
      "    Properties: {}",
      "  Other:",
      "    <<: *role",
      "    Properties:",
      "      RoleName: !Sub ${AWS::StackName}-other",
    ].join("\n");
    expect(mergeKeysIn(parseTemplate(template))).toEqual([
      "a merge key at Resources.Other",
    ]);
  });

  it("finds a merge key inside a list, and at the top", () => {
    expect(mergeKeysIn({ "<<": {}, a: [{ b: { "<<": {} } }] })).toEqual([
      "a merge key at the top",
      "a merge key at a.0.b",
    ]);
  });

  // js-yaml merges a `!!merge` tag on an empty key, which the yaml package
  // reads as the key "".
  it("finds a merge tag on an empty key", () => {
    const tagged = "Base: &b { Type: T }\nR:\n  !!merge : *b\n";
    expect(mergeKeysIn(parse(tagged, { logLevel: "error" }))).toEqual([
      "an empty key, which osls may read as a merge, at R",
    ]);
  });

  it("stops at an alias that holds itself", () => {
    expect(mergeKeysIn(parse("a: &x\n  b: *x\n  <<: {}\n"))).toEqual([
      "a merge key at a",
    ]);
  });

  it("finds nothing in YAML without one", () => {
    expect(
      mergeKeysIn(parse("Resources:\n  R: { Type: T, Properties: {} }")),
    ).toEqual([]);
  });
});
