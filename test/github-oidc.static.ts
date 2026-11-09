import { describe, expect, it } from "vitest";
import { serverless, site } from "./app.ts";
import { readRepoFile } from "./repo.ts";
import {
  list,
  patternWithin,
  patternsOverlap,
  readTemplate,
  renderArn,
  resource,
  rightsOf,
  subText,
  trustOf,
  wildcardMatches,
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
      .flatMap(resources)
      // The read of the dns stack, which the next test pins.
      .filter(
        (resource) =>
          resource !==
          "arn:${AWS::Partition}:cloudformation:us-east-1:${AWS::AccountId}:stack/dns/*",
      );
    expect(stacks).toEqual([
      "arn:${AWS::Partition}:cloudformation:eu-west-2:${AWS::AccountId}:stack/grantlink-prod/*",
    ]);
  });

  // The app stack reads the certificate's ARN from the dns stack at deploy
  // time (#43). That read is the role's only right in us-east-1.
  it("reads the dns stack in us-east-1, and does nothing else there", () => {
    const east = allows(rightsOf(deploy)).filter((statement) =>
      resources(statement).some((resource) => resource.includes("us-east-1")),
    );
    expect(east).toEqual([
      {
        Sid: "ReadDnsStack",
        Effect: "Allow",
        Action: "cloudformation:DescribeStacks",
        Resource: {
          "Fn::Sub":
            "arn:${AWS::Partition}:cloudformation:us-east-1:${AWS::AccountId}:stack/dns/*",
        },
      },
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
      objectActions.some((action) => wildcardMatches(pattern, action)),
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
        .some((pattern) => wildcardMatches(pattern, text)),
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
    expect([...new Set(iam.flatMap(resources))]).toEqual([
      "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/grantlink-prod-*",
    ]);
  });

  // The actions that give a role its rights, and the boundary's own (#33).
  const granting = [
    "iam:AttachRolePolicy",
    "iam:CreateRole",
    "iam:PutRolePermissionsBoundary",
    "iam:PutRolePolicy",
  ];

  it("gives a role rights only when the role carries the boundary", () => {
    const giving = allows(rightsOf(execution)).filter((statement) =>
      actions(statement).some((pattern) =>
        granting.some((action) => wildcardMatches(pattern, action)),
      ),
    );
    expect(giving).toEqual([
      {
        Sid: "BoundedAppRoles",
        Effect: "Allow",
        Action: granting,
        Resource: {
          "Fn::Sub":
            "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/grantlink-prod-*",
        },
        Condition: {
          StringEquals: {
            "iam:PermissionsBoundary": { Ref: "AppRoleBoundary" },
          },
        },
      },
    ]);
  });

  it("cannot take the boundary off a role", () => {
    expect(rightsOf(execution)).toContainEqual({
      Sid: "KeepBoundary",
      Effect: "Deny",
      Action: "iam:DeleteRolePermissionsBoundary",
      Resource: "*",
    });
    expect(
      allows(rightsOf(execution))
        .flatMap(actions)
        .some((pattern) =>
          wildcardMatches(pattern, "iam:DeleteRolePermissionsBoundary"),
        ),
    ).toBe(false);
  });

  it("cannot change the boundary policy", () => {
    expect(rightsOf(execution)).toContainEqual({
      Sid: "KeepBoundaryPolicy",
      Effect: "Deny",
      Action: [
        "iam:CreatePolicyVersion",
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
        "iam:TagPolicy",
        "iam:UntagPolicy",
      ],
      Resource: { Ref: "AppRoleBoundary" },
    });
    expect(
      allows(rightsOf(execution))
        .flatMap(resources)
        .some((resource) => resource.includes(":policy/")),
    ).toBe(false);
  });
});

describe("the app roles' boundary", () => {
  const boundary = template.Resources.AppRoleBoundary;
  const document = (boundary?.Properties.PolicyDocument ?? {
    Statement: [],
  }) as { Statement: Statement[] };
  const sub = (text: string): { "Fn::Sub": string } => ({ "Fn::Sub": text });
  const london = "eu-west-2:${AWS::AccountId}";
  const text = "arn:${AWS::Partition}:s3:::grantlink-text-${AWS::AccountId}";
  const run = `arn:\${AWS::Partition}:lambda:${london}:function:grantlink-prod-run`;

  it("is a managed policy with the name the app stack gives its roles", () => {
    expect(boundary?.Type).toBe("AWS::IAM::ManagedPolicy");
    expect(boundary?.Properties.ManagedPolicyName).toBe(
      "grantlink-app-boundary",
    );
  });

  it("allows only what the app stack's roles use, and no write under eval-reports/", () => {
    expect(document.Statement).toEqual([
      {
        Sid: "ResultsTable",
        Effect: "Allow",
        Action: [
          "dynamodb:BatchGetItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Scan",
          "dynamodb:UpdateItem",
        ],
        Resource: sub(
          `arn:\${AWS::Partition}:dynamodb:${london}:table/grantlink-prod-ResultsTable-*`,
        ),
      },
      {
        Sid: "FundingText",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject"],
        Resource: [sub(`${text}/cache/*`), sub(`${text}/eval/*`)],
      },
      {
        Sid: "ListSnapshot",
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: sub(text),
        Condition: { StringLike: { "s3:prefix": ["eval/*"] } },
      },
      {
        Sid: "PublishPage",
        Effect: "Allow",
        Action: "s3:PutObject",
        Resource: [
          sub(
            "arn:${AWS::Partition}:s3:::grantlink-prod-sitebucket-*/index.html",
          ),
          sub(
            "arn:${AWS::Partition}:s3:::grantlink-prod-sitebucket-*/found.json",
          ),
        ],
      },
      {
        Sid: "RunLogs",
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:TagResource",
        ],
        Resource: [
          sub(
            `arn:\${AWS::Partition}:logs:${london}:log-group:/aws/lambda/grantlink-prod-run`,
          ),
          sub(
            `arn:\${AWS::Partition}:logs:${london}:log-group:/aws/lambda/grantlink-prod-run:*`,
          ),
        ],
      },
      {
        Sid: "RunCheckpoints",
        Effect: "Allow",
        Action: [
          "lambda:CheckpointDurableExecution",
          "lambda:GetDurableExecutionState",
        ],
        Resource: sub(`${run}:*/durable-execution/*/*`),
      },
      {
        Sid: "StartRun",
        Effect: "Allow",
        Action: "lambda:InvokeFunction",
        Resource: sub(`${run}:*`),
      },
      {
        Sid: "ModelKey",
        Effect: "Allow",
        Action: "secretsmanager:GetSecretValue",
        Resource: sub(
          `arn:\${AWS::Partition}:secretsmanager:${london}:secret:grantlink-*`,
        ),
      },
      {
        Sid: "NoEvalReports",
        Effect: "Deny",
        Action: "s3:*",
        Resource: sub(`${text}/eval-reports/*`),
      },
    ]);
  });

  // The boundary names the table, the page's bucket and the function by
  // the names CloudFormation and osls give them. Naming one in the app
  // stack, or changing the service or the stage, would stop it matching.
  it("names the app stack's resources as they are created", () => {
    expect(serverless.service).toBe("grantlink");
    expect(serverless.provider.stage).toBe("prod");
    expect(Object.keys(serverless.functions ?? {})).toEqual(["run"]);
    expect(serverless.functions?.run?.name).toBeUndefined();
    const data = readTemplate("infra/data.cfn.yml");
    expect(resource(data, "ResultsTable").Properties.TableName).toBeUndefined();
    expect(resource(site, "SiteBucket").Properties.BucketName).toBeUndefined();
  });

  // Every action the run's role is given in serverless.yml, so the
  // boundary does not quietly take one away.
  it("allows every action the run's role uses", () => {
    const used = (serverless.provider.iam?.role?.statements ?? []).flatMap(
      (statement) => list(statement.Action),
    );
    const bounded = allows(document.Statement).flatMap(actions);
    expect(used.length).toBeGreaterThan(0);
    for (const action of used) {
      expect(bounded, action).toContain(action);
    }
  });
});

// The run's role and its boundary, both rendered to ARNs, so a pattern in
// the boundary that drifts from the name a resource is given fails here and
// not as AccessDenied in production (#104).
describe("the run's role inside the boundary", () => {
  const boundary = (
    template.Resources.AppRoleBoundary?.Properties.PolicyDocument as {
      Statement: Statement[];
    }
  ).Statement;
  const { service } = serverless;
  const { region, stage } = serverless.provider;
  const stack = `${service}-${stage}`;
  const account = "ACCOUNT";
  const london = `${region}:${account}`;
  // CloudFormation names a resource the template leaves unnamed
  // <stack>-<logical id>-<suffix>, and lowercases the name of a bucket.
  const generated = (logicalId: string): string =>
    `${stack}-${logicalId}-1A2B3C4D5E6F`;
  const names = {
    "AWS::Partition": "aws",
    "AWS::Region": region,
    "AWS::AccountId": account,
    "ResultsTable.Arn": `arn:aws:dynamodb:${london}:table/${generated("ResultsTable")}`,
    "SiteBucket.Arn": `arn:aws:s3:::${generated("SiteBucket").toLowerCase()}`,
  };

  // The functions that run as the role, named as osls names them.
  const functions = Object.entries(serverless.functions ?? {}).map(
    ([key, config]) => ({
      name: `${stack}-${key}`,
      durable: "durableConfig" in config,
    }),
  );

  // What osls adds to the run's role, pinned from osls's
  // merge-iam-templates.js, since reading it from `serverless package` is
  // not offline. osls grants the logs on /aws/lambda/grantlink-prod*, which
  // reaches every function the stack makes, so each function's own log
  // group stands for that wildcard here.
  const sub = (text: string): { "Fn::Sub": string } => ({ "Fn::Sub": text });
  const logGroup = (name: string): string =>
    `arn:\${AWS::Partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/${name}`;
  const fromOsls: Statement[] = [
    {
      Effect: "Allow",
      Action: [
        "logs:CreateLogStream",
        "logs:CreateLogGroup",
        "logs:TagResource",
      ],
      Resource: functions.flatMap(({ name }) => [
        sub(logGroup(name)),
        sub(`${logGroup(name)}:*`),
      ]),
    },
    {
      Effect: "Allow",
      Action: ["logs:PutLogEvents"],
      Resource: functions.map(({ name }) => sub(`${logGroup(name)}:*:*`)),
    },
    {
      Effect: "Allow",
      Action: [
        "lambda:CheckpointDurableExecution",
        "lambda:GetDurableExecutionState",
      ],
      Resource: functions
        .filter(({ durable }) => durable)
        .map(({ name }) =>
          sub(
            `arn:\${AWS::Partition}:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${name}:*/durable-execution/*/*`,
          ),
        ),
    },
  ];
  const held = [
    ...((serverless.provider.iam?.role?.statements ?? []) as Statement[]),
    ...fromOsls,
  ];

  // Each action and resource a statement asks for that no Allow in the
  // policy covers with the same or no condition, or that a Deny reaches.
  const outside = (asked: Statement[], policy: Statement[]): string[] =>
    asked.flatMap((statement) =>
      actions(statement).flatMap((action) =>
        list(statement.Resource)
          .map((value) => renderArn(value, names))
          .filter((arn) => {
            const reaches = (rule: Statement): boolean =>
              actions(rule).some((pattern) => wildcardMatches(pattern, action));
            const allowed = policy.some(
              (rule) =>
                rule.Effect === "Allow" &&
                reaches(rule) &&
                (rule.Condition === undefined ||
                  JSON.stringify(rule.Condition) ===
                    JSON.stringify(statement.Condition)) &&
                list(rule.Resource).some((value) =>
                  patternWithin(arn, renderArn(value, names)),
                ),
            );
            const denied = policy.some(
              (rule) =>
                rule.Effect === "Deny" &&
                reaches(rule) &&
                list(rule.Resource).some((value) =>
                  patternsOverlap(arn, renderArn(value, names)),
                ),
            );
            return !allowed || denied;
          })
          .map((arn) => `${action} ${arn}`),
      ),
    );

  // A change to osls's version may change what it adds to the role.
  it("pins what the osls version in use adds", () => {
    const { devDependencies } = JSON.parse(readRepoFile("package.json")) as {
      devDependencies: Record<string, string>;
    };
    expect(devDependencies.osls).toBe("4.5.0");
  });

  it("asks for nothing the boundary does not allow", () => {
    expect(held.flatMap((statement) => list(statement.Resource))).not.toEqual(
      [],
    );
    expect(outside(held, boundary)).toEqual([]);
  });

  it("would fail if the boundary named the page's bucket another way", () => {
    const drifted = JSON.parse(
      JSON.stringify(boundary).replaceAll("-sitebucket-", "-site-"),
    ) as Statement[];
    expect(outside(held, drifted)).toEqual([
      `s3:PutObject arn:aws:s3:::${generated("SiteBucket").toLowerCase()}/index.html`,
      `s3:PutObject arn:aws:s3:::${generated("SiteBucket").toLowerCase()}/found.json`,
    ]);
  });

  it("would fail if the boundary dropped a log group osls grants", () => {
    const drifted = boundary.filter((rule) => rule.Sid !== "RunLogs");
    expect(outside(held, drifted)).toContain(
      `logs:PutLogEvents arn:aws:logs:${london}:log-group:/aws/lambda/${stack}-run:*:*`,
    );
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

describe("fitness: the session role reads the snapshot and nothing else (evals.md)", () => {
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

describe("fitness: only CI files reports (evals.md)", () => {
  const report =
    "arn:${AWS::Partition}:s3:::grantlink-text-${AWS::AccountId}/eval-reports/a-report.json";

  // Whether a statement applies to putting a report, reading Action or
  // NotAction and Resource or NotResource with their wildcards.
  const appliesToReport = (statement: Statement): boolean => {
    const action =
      statement.NotAction === undefined
        ? actions(statement).some((pattern) =>
            wildcardMatches(pattern, "s3:PutObject"),
          )
        : !list(statement.NotAction).some((pattern) =>
            wildcardMatches(pattern, "s3:PutObject"),
          );
    const resource =
      statement.NotResource === undefined
        ? resources(statement).some((pattern) =>
            wildcardMatches(pattern, report),
          )
        : !list(statement.NotResource)
            .map(subText)
            .some((pattern) => wildcardMatches(pattern, report));
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
    expect(wildcardMatches("s3:Get*", "s3:GetObject")).toBe(true);
    expect(wildcardMatches("s3:*Object", "s3:PutObject")).toBe(true);
    expect(wildcardMatches("s3:GetBucket*", "s3:GetObject")).toBe(false);
  });
});
