import { describe, expect, it } from "vitest";
import { serverless } from "./app.ts";
import {
  list,
  readTemplate,
  resource,
  rightsOf,
  subText,
  trustOf,
  type Statement,
} from "./cfn.ts";

// Pins who each role trusts and what it may do, so a change to either shows
// in review as a failing test (#15, #9).
const template = readTemplate("infra/github-oidc.cfn.yml");
const provider = { Ref: "GitHubOidcProvider" };
// GitHub's subject for a repository made after 15 July 2026 carries the
// owner's and the repository's immutable ids (#48).
const repo = "repo:t-d-d@4635510/grantlink@1449324689";

const deploy = resource(template, "DeployRole");
const execution = resource(template, "DeployExecutionRole");
const ciEval = resource(template, "CiEvalRole");
const accessEval = resource(template, "AccessEvalRole");
const roles = { deploy, execution, ciEval, accessEval };

const actions = (statement: Statement): string[] => list(statement.Action);
const resources = (statement: Statement): string[] =>
  list(statement.Resource).map(subText);
const allows = (statements: Statement[]): Statement[] =>
  statements.filter((statement) => statement.Effect === "Allow");

// Whether an IAM action pattern, wildcards and all, covers an action.
const covers = (pattern: string, action: string): boolean =>
  new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`,
    "iu",
  ).test(action);

// The trust a role gets from GitHub's OIDC provider for one environment.
const githubTrust = (environment: string): Statement[] => [
  {
    Effect: "Allow",
    Principal: { Federated: provider },
    Action: "sts:AssumeRoleWithWebIdentity",
    Condition: {
      StringEquals: {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": `${repo}:environment:${environment}`,
      },
    },
  },
];

describe("the roles stack", () => {
  it("needs no value typed by the person applying it", () => {
    expect(Object.keys(template.Parameters ?? {})).toEqual(["AccessAccountId"]);
  });
});

describe("GitHub's OIDC provider", () => {
  it("is GitHub's issuer, for STS", () => {
    const { Properties } = resource(template, "GitHubOidcProvider");
    expect(resource(template, "GitHubOidcProvider").Type).toBe(
      "AWS::IAM::OIDCProvider",
    );
    expect(Properties.Url).toBe("https://token.actions.githubusercontent.com");
    expect(Properties.ClientIdList).toEqual(["sts.amazonaws.com"]);
  });
});

describe("the deploy role", () => {
  it("trusts only this repo's prod environment", () => {
    expect(trustOf(deploy)).toEqual(githubTrust("prod"));
  });

  it("changes only the app stack, and only in London", () => {
    const stacks = allows(rightsOf(deploy))
      .filter((statement) =>
        actions(statement).some((action) =>
          action.startsWith("cloudformation:"),
        ),
      )
      .filter((statement) =>
        actions(statement).some(
          (action) => action !== "cloudformation:ValidateTemplate",
        ),
      )
      .flatMap(resources);
    expect(stacks).toEqual([
      "arn:${AWS::Partition}:cloudformation:eu-west-2:${AWS::AccountId}:stack/grantlink-prod/*",
    ]);
  });

  it("passes only the execution role, and only to CloudFormation", () => {
    const passes = allows(rightsOf(deploy)).filter((statement) =>
      actions(statement).includes("iam:PassRole"),
    );
    expect(passes).toHaveLength(1);
    expect(passes[0]?.Resource).toEqual({
      "Fn::GetAtt": ["DeployExecutionRole", "Arn"],
    });
    expect(passes[0]?.Condition).toEqual({
      StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" },
    });
  });

  it("cannot reach the private bucket's objects", () => {
    expect(rightsOf(deploy)).toContainEqual({
      Sid: "NoPrivateBucket",
      Effect: "Deny",
      Action: "s3:*",
      Resource: [
        {
          "Fn::Sub":
            "arn:${AWS::Partition}:s3:::grantlink-text-${AWS::AccountId}",
        },
        {
          "Fn::Sub":
            "arn:${AWS::Partition}:s3:::grantlink-text-${AWS::AccountId}/*",
        },
      ],
    });
  });
});

describe("the deploy execution role", () => {
  it("is assumed only by CloudFormation in this account", () => {
    expect(trustOf(execution)).toEqual([
      {
        Effect: "Allow",
        Principal: { Service: "cloudformation.amazonaws.com" },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
        },
      },
    ]);
  });

  // Lambda reads a new function's code from osls's deployment bucket with
  // the credentials of the role CloudFormation runs as (#58).
  const objectActions = [
    "s3:GetObject",
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:RestoreObject",
  ];
  const reachingObjects = allows(rightsOf(execution)).filter((statement) =>
    actions(statement).some((pattern) =>
      objectActions.some((action) => covers(pattern, action)),
    ),
  );

  it("manages buckets, and reads objects only to fetch a function's code", () => {
    expect(
      reachingObjects.map((statement) => [
        actions(statement),
        resources(statement),
      ]),
    ).toEqual([
      [
        ["s3:GetObject"],
        [
          "arn:${AWS::Partition}:s3:::grantlink-prod-serverlessdeploymentbucket-*/*",
        ],
      ],
    ]);
  });

  it("cannot read the private bucket's objects", () => {
    const text =
      "arn:${AWS::Partition}:s3:::grantlink-text-${AWS::AccountId}/cache/PMC1.json";
    expect(
      reachingObjects
        .flatMap(resources)
        .some((pattern) => covers(pattern, text)),
    ).toBe(false);
  });

  // A Deny holds even if a later Allow is widened by mistake.
  it("is denied every object in the private bucket", () => {
    expect(
      rightsOf(execution).filter((statement) => statement.Effect === "Deny"),
    ).toContainEqual(
      expect.objectContaining({
        Action: "s3:*",
        Resource: {
          "Fn::Sub":
            "arn:${AWS::Partition}:s3:::grantlink-text-${AWS::AccountId}/*",
        },
      }),
    );
  });

  // The pattern is the name CloudFormation gives osls's deployment bucket in
  // the stack grantlink-prod. Naming the bucket in serverless.yml, or
  // changing the service or the stage, would stop it matching.
  it("names the deployment bucket as osls creates it", () => {
    expect(serverless.service).toBe("grantlink");
    expect(serverless.provider.stage).toBe("prod");
    expect(
      (serverless.provider as { deploymentBucket?: unknown }).deploymentBucket,
    ).toBeUndefined();
  });

  it("can read, update and delete the roles it creates", () => {
    const granted = allows(rightsOf(execution)).flatMap(actions);
    for (const action of [
      "iam:GetRole",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:UpdateRole",
      "iam:DeleteRole",
    ]) {
      expect(granted).toContain(action);
    }
  });

  it("creates and passes only the app stack's own roles", () => {
    const iam = allows(rightsOf(execution)).filter((statement) =>
      actions(statement).some((action) => action.startsWith("iam:")),
    );
    expect(iam.flatMap(resources)).toEqual([
      "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/grantlink-prod-*",
    ]);
  });
});

describe("the CI eval role", () => {
  it("trusts only this repo's eval environment", () => {
    expect(trustOf(ciEval)).toEqual(githubTrust("eval"));
  });

  it("reads the snapshot and the reports", () => {
    expect(rightsOf(ciEval)).toContainEqual({
      Sid: "ReadSnapshotAndReports",
      Effect: "Allow",
      Action: "s3:GetObject",
      Resource: [
        {
          "Fn::Sub":
            "arn:${AWS::Partition}:s3:::grantlink-text-${AWS::AccountId}/eval/*",
        },
        {
          "Fn::Sub":
            "arn:${AWS::Partition}:s3:::grantlink-text-${AWS::AccountId}/eval-reports/*",
        },
      ],
    });
  });

  it("adds a report only where none exists, and cannot overwrite one", () => {
    const writes = allows(rightsOf(ciEval)).filter((statement) =>
      actions(statement).some(
        (action) => action !== "s3:GetObject" && action !== "s3:ListBucket",
      ),
    );
    expect(writes).toEqual([
      {
        Sid: "AddReportsOnly",
        Effect: "Allow",
        Action: "s3:PutObject",
        Resource: {
          "Fn::Sub":
            "arn:${AWS::Partition}:s3:::grantlink-text-${AWS::AccountId}/eval-reports/*",
        },
        Condition: { StringEquals: { "s3:if-none-match": "*" } },
      },
    ]);
  });

  it("lists only the eval prefixes", () => {
    const listing = allows(rightsOf(ciEval)).filter((statement) =>
      actions(statement).includes("s3:ListBucket"),
    );
    expect(listing).toEqual([
      {
        Sid: "ListEvalPrefixes",
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: {
          "Fn::Sub":
            "arn:${AWS::Partition}:s3:::grantlink-text-${AWS::AccountId}",
        },
        Condition: {
          StringLike: { "s3:prefix": ["eval/*", "eval-reports/*"] },
        },
      },
    ]);
  });
});

describe("access-eval", () => {
  it("is named for aws-access's grantlink-eval profile", () => {
    expect(accessEval.Properties.RoleName).toBe("access-eval");
  });

  it("trusts only claude-grantlink in the access account", () => {
    expect(trustOf(accessEval)).toEqual([
      {
        Effect: "Allow",
        Principal: {
          AWS: {
            "Fn::Sub":
              "arn:${AWS::Partition}:iam::${AccessAccountId}:role/claude-grantlink",
          },
        },
        Action: "sts:AssumeRole",
      },
    ]);
  });

  it("reads the access account's id from SSM, not the template", () => {
    expect(template.Parameters?.AccessAccountId).toMatchObject({
      Type: "AWS::SSM::Parameter::Value<String>",
      Default: "/access/account-id",
    });
  });

  it("allows only s3:GetObject on eval/*, and denies everything else", () => {
    const snapshot = {
      "Fn::Sub":
        "arn:${AWS::Partition}:s3:::grantlink-text-${AWS::AccountId}/eval/*",
    };
    expect(rightsOf(accessEval)).toEqual([
      {
        Sid: "ReadSnapshot",
        Effect: "Allow",
        Action: "s3:GetObject",
        Resource: snapshot,
      },
      {
        Sid: "DenyOtherActions",
        Effect: "Deny",
        NotAction: "s3:GetObject",
        Resource: "*",
      },
      {
        Sid: "DenyOtherObjects",
        Effect: "Deny",
        Action: "s3:GetObject",
        NotResource: snapshot,
      },
    ]);
    expect(accessEval.Properties.ManagedPolicyArns).toBeUndefined();
  });
});

describe("only the CI eval role writes to eval-reports/", () => {
  const report =
    "arn:${AWS::Partition}:s3:::grantlink-text-${AWS::AccountId}/eval-reports/a-report.json";

  // Whether a statement applies to putting a report, reading Action or
  // NotAction and Resource or NotResource with their wildcards.
  const appliesToReport = (statement: Statement): boolean => {
    const action =
      statement.NotAction === undefined
        ? actions(statement).some((pattern) => covers(pattern, "s3:PutObject"))
        : !list(statement.NotAction).some((pattern) =>
            covers(pattern, "s3:PutObject"),
          );
    const resource =
      statement.NotResource === undefined
        ? resources(statement).some((pattern) => covers(pattern, report))
        : !list(statement.NotResource)
            .map(subText)
            .some((pattern) => covers(pattern, report));
    return action && resource;
  };

  // An Allow that applies, and no Deny that does.
  const writesReports = (role: typeof deploy): boolean => {
    const applying = rightsOf(role).filter(appliesToReport);
    return (
      applying.some((statement) => statement.Effect === "Allow") &&
      !applying.some((statement) => statement.Effect === "Deny")
    );
  };

  it.each(Object.entries(roles).filter(([name]) => name !== "ciEval"))(
    "%s cannot",
    (_name, role) => {
      expect(writesReports(role)).toBe(false);
    },
  );

  it("ciEval can", () => {
    expect(writesReports(ciEval)).toBe(true);
  });

  // Its wildcard on grantlink-* reaches the bucket. Only the Deny stops it.
  it("deploy is stopped by its Deny, not by its Allows", () => {
    expect(
      allows(rightsOf(deploy)).some((statement) => appliesToReport(statement)),
    ).toBe(true);
  });
});

describe("every role", () => {
  it.each(Object.entries(roles))("%s has inline rights only", (_name, role) => {
    expect(role.Type).toBe("AWS::IAM::Role");
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
  });

  // An Allow with NotAction grants everything it does not name, past every
  // check above that reads Action.
  it.each(Object.entries(roles))("%s allows by Action only", (_name, role) => {
    const notActions = allows(rightsOf(role)).filter(
      (statement) => statement.NotAction !== undefined,
    );
    expect(notActions).toEqual([]);
  });

  it("knows a wildcard covers the actions it names", () => {
    expect(covers("s3:Get*", "s3:GetObject")).toBe(true);
    expect(covers("s3:*Object", "s3:PutObject")).toBe(true);
    expect(covers("s3:GetBucket*", "s3:GetObject")).toBe(false);
  });
});
