import { describe, expect, it } from "vitest";
import { appStack, DATA_TEMPLATE, serverless } from "./app.ts";
import {
  list,
  readTemplate,
  renderArn,
  resource,
  rightsOf,
  subText,
  trustOf,
  wildcardMatches,
  type PolicyDocument,
  type Statement,
} from "./cfn.ts";
import {
  BucketPolicy,
  grantsInPolicy,
  refusesPlainHttp,
} from "./bucket-policy.ts";
import { readRepoFile } from "./repo.ts";

// The run's resources in the app stack (#19): the results table and the
// funding text bucket from infra/data.cfn.yml, and the function and its
// first run from serverless.yml. Each check reads the stack as osls merges
// it, so an override in serverless.yml shows (#166).

type Resources = Record<
  string,
  { Type: string; Properties: Record<string, unknown> }
>;
const inline = (serverless.resources as unknown[]).flatMap((entry) =>
  typeof entry === "object" && entry !== null && "Resources" in entry
    ? [(entry as { Resources: Resources }).Resources]
    : [],
);
const inlineResources: Resources = Object.assign({}, ...inline) as Resources;

const run = serverless.functions?.run as {
  handler: string;
  runtime?: string;
  timeout: number;
  durableConfig?: { executionTimeout: number; retentionPeriodInDays?: number };
  environment: Record<string, unknown>;
  events?: unknown[];
};

describe("the app stack takes the data template", () => {
  it("lists infra/data.cfn.yml among its resources", () => {
    expect(serverless.resources).toContain(`\${file(./${DATA_TEMPLATE})}`);
  });
});

describe("fitness: the bucket stays private (storage.md)", () => {
  const bucket = resource(appStack, "TextBucket").Properties;

  it("is named as the roles stack expects", () => {
    expect(subText(bucket.BucketName)).toBe("grantlink-text-${AWS::AccountId}");
  });

  it("blocks all public access and has no website", () => {
    expect(bucket.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket.WebsiteConfiguration).toBeUndefined();
  });

  // The deploy role may change the bucket's ownership controls and its ACL
  // (#65). With ACLs on, a grant to another account would hand it the
  // objects, and IgnorePublicAcls stops only public grants.
  it("turns ACLs off and sets none", () => {
    expect(bucket.OwnershipControls).toEqual({
      Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
    });
    expect(bucket.AccessControl).toBeUndefined();
    // osls merges serverless.yml's later entries over the template, so an
    // override there would change the bucket without showing above.
    const extensions = (serverless.resources as unknown[]).flatMap((entry) =>
      typeof entry === "object" && entry !== null && "extensions" in entry
        ? Object.keys((entry as { extensions: object }).extensions)
        : [],
    );
    expect(Object.keys(inlineResources)).not.toContain("TextBucket");
    expect(extensions).not.toContain("TextBucket");
  });

  it("is encrypted with S3's own keys", () => {
    expect(bucket.BucketEncryption).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    });
  });

  // The same check test/text-bucket.conformance.ts makes of the deployed
  // policy (#135), so a narrowed Deny fails here before it deploys (#148).
  // The template names the bucket by GetAtt and Sub, so each resource is
  // rendered with a stand-in account first. The bucket's ARN and its name
  // written out render the same, so either way of naming it passes.
  it("refuses plain HTTP for everyone, every action, the bucket and its objects", () => {
    const bucketArn = "arn:aws:s3:::grantlink-text-ACCOUNT";
    const names = {
      "AWS::Partition": "aws",
      "AWS::AccountId": "ACCOUNT",
      "TextBucket.Arn": bucketArn,
    };
    const policy = BucketPolicy.parse(
      resource(appStack, "TextBucketPolicy").Properties.PolicyDocument,
    );
    const rendered = {
      Statement: policy.Statement.map((statement) => ({
        ...statement,
        Resource: list(statement.Resource).map((value) =>
          renderArn(value, names),
        ),
      })),
    };
    expect(refusesPlainHttp(rendered, bucketArn)).toBe(true);
  });

  // The deploy role may put any policy on this bucket (#59), so the
  // template is where a policy granting funding text would show.
  it("has a policy that only denies, so it grants no one its objects", () => {
    const onTextBucket = Object.entries(appStack.Resources).filter(
      ([, r]) =>
        r.Type === "AWS::S3::BucketPolicy" &&
        /TextBucket|grantlink-text/u.test(JSON.stringify(r.Properties.Bucket)),
    );
    expect(onTextBucket.map(([name]) => name)).toEqual(["TextBucketPolicy"]);
    for (const [name, policy] of onTextBucket) {
      // The same check test/text-bucket.conformance.ts makes of the
      // deployed policy (#67).
      expect(grantsInPolicy(policy.Properties.PolicyDocument), name).toEqual(
        [],
      );
    }
  });
});

describe("fitness: one on-demand table (storage.md)", () => {
  it("bills on demand, keyed by PMCID", () => {
    const table = resource(appStack, "ResultsTable").Properties;
    expect(table.BillingMode).toBe("PAY_PER_REQUEST");
    expect(table.KeySchema).toEqual([
      { AttributeName: "pmcid", KeyType: "HASH" },
    ]);
    expect(
      Object.values(appStack.Resources).filter(
        (r) => r.Type === "AWS::DynamoDB::Table",
      ),
    ).toHaveLength(1);
  });
});

// A failed update that created a data store rolls back by deleting it, and
// a replacement deletes the old one. Either would lose data, and a bucket
// that holds data stalls the rollback instead (#89).
describe("the data stores outlive a rollback or a replacement (#89)", () => {
  it.each(["ResultsTable", "TextBucket"])("%s is retained", (name) => {
    const store = resource(appStack, name);
    expect(store.DeletionPolicy).toBe("Retain");
    expect(store.UpdateReplacePolicy).toBe("Retain");
  });
});

describe("fitness: a run is a durable function on a published version (durable-execution.md)", () => {
  it("is a durable function, which osls publishes as a version behind an alias", () => {
    expect(run.handler).toBe("src/run/lambda.handler");
    expect(run.durableConfig?.executionTimeout).toBeGreaterThan(900);
  });

  it("is started by a one-time schedule, at the alias, never $LATEST", () => {
    expect(run.events ?? []).toEqual([]);
    const schedule = appStack.Resources.FirstRunSchedule;
    expect(schedule?.Type).toBe("AWS::Scheduler::Schedule");
    const props = schedule?.Properties as {
      ScheduleExpression: string;
      Target: { Arn: unknown };
    };
    expect(props.ScheduleExpression).toBe("at(${env:FIRST_RUN_AT})");
    expect(props.Target.Arn).toEqual({ Ref: "RunDurableLambdaAlias" });
  });

  it("lets the schedule invoke only the alias", () => {
    const role = resource(appStack, "FirstRunRole");
    expect(trustOf(role).map((s) => s.Principal)).toEqual([
      { Service: "scheduler.amazonaws.com" },
    ]);
    expect(rightsOf(role)).toEqual([
      expect.objectContaining({
        Effect: "Allow",
        Action: "lambda:InvokeFunction",
        Resource: { Ref: "RunDurableLambdaAlias" },
      }),
    ]);
  });

  it("keeps the first run's time, so a later deploy starts no second run", () => {
    const outputs = (
      serverless.resources as { Outputs?: Record<string, { Value: string }> }[]
    )
      .map((entry) => entry.Outputs?.FirstRunAt?.Value)
      .filter(Boolean);
    expect(outputs).toEqual(["${env:FIRST_RUN_AT}"]);
  });
});

describe("the function", () => {
  it("runs on a Node runtime durable functions support", () => {
    expect(["nodejs22.x", "nodejs24.x"]).toContain(
      run.runtime ?? (serverless.provider as { runtime?: string }).runtime,
    );
  });

  it("is told where the stores and the page are", () => {
    expect(Object.keys(run.environment).sort()).toEqual([
      "CODE_VERSION",
      "SITE_BUCKET",
      "TABLE_NAME",
      "TEXT_BUCKET",
    ]);
  });

  it("may write funding text only under cache/ and eval/, and publish only the page and its data", () => {
    const text = readRepoFile("serverless.yml");
    expect(text).toContain("grantlink-text-${AWS::AccountId}/cache/*");
    expect(text).toContain("grantlink-text-${AWS::AccountId}/eval/*");
    expect(text).not.toMatch(/grantlink-text-\$\{AWS::AccountId\}\/\*/u);
    expect(text).not.toContain("eval-reports");
    expect(text).toContain("/index.html");
    expect(text).toContain("/found.json");
  });

  it("lists only the snapshot's prefix, so a missing manifest reads as missing", () => {
    const statements = (
      serverless.provider as {
        iam?: { role?: { statements?: Record<string, unknown>[] } };
      }
    ).iam?.role?.statements;
    const list = statements?.find(
      (statement) => statement.Action === "s3:ListBucket",
    );
    expect(list?.Condition).toEqual({
      StringLike: { "s3:prefix": ["eval/*"] },
    });
  });

  it("reads only the live release record from the page's bucket, so a missing one reads as missing", () => {
    const statements =
      (
        serverless.provider as {
          iam?: { role?: { statements?: Record<string, unknown>[] } };
        }
      ).iam?.role?.statements ?? [];
    const onSite = statements.filter((statement) =>
      JSON.stringify(statement.Resource).includes("SiteBucket"),
    );
    expect(onSite.map((statement) => statement.Action)).toEqual([
      "s3:PutObject",
      "s3:GetObject",
      "s3:ListBucket",
    ]);
    expect(JSON.stringify(onSite[1]?.Resource)).toBe(
      JSON.stringify({ "Fn::Sub": "${SiteBucket.Arn}/release.json" }),
    );
    expect(onSite[2]?.Resource).toEqual({
      "Fn::GetAtt": ["SiteBucket", "Arn"],
    });
    expect(onSite[2]?.Condition).toEqual({
      StringEquals: { "s3:prefix": "release.json" },
    });
  });

  it("carries the gold sets and the release record it publishes with", () => {
    const patterns = (
      serverless as unknown as { package: { patterns: string[] } }
    ).package.patterns;
    expect(patterns).toContain("evals/**");
    expect(patterns).toContain("!evals/**/*.test.ts");
    expect(patterns).toContain("site/release.json");
  });
});

describe("fitness: cache entries never change (evals.md)", () => {
  const policy = resource(appStack, "TextBucketPolicy").Properties
    .PolicyDocument as { Statement: Record<string, unknown>[] };
  const writeOnce = policy.Statement.find(
    (statement) => statement.Sid === "WriteOnceUnderEval",
  );

  it("refuses any write under eval/ or eval-reports/ that could replace an object", () => {
    expect(writeOnce).toMatchObject({
      Effect: "Deny",
      Principal: "*",
      Action: "s3:PutObject",
      Condition: { StringNotEquals: { "s3:if-none-match": "*" } },
    });
    expect((writeOnce?.Resource as unknown[]).map((r) => subText(r))).toEqual([
      "${TextBucket.Arn}/eval/*",
      "${TextBucket.Arn}/eval-reports/*",
    ]);
  });
});

// The roles stack holds the boundary, and the execution role creates a role
// only when it carries it (#33).
describe("every role in the app stack carries the boundary", () => {
  const roles = readTemplate("infra/github-oidc.cfn.yml");
  const name = roles.Resources.AppRoleBoundary?.Properties.ManagedPolicyName as
    string | undefined;
  const declared = Object.entries(appStack.Resources).filter(
    ([, r]) => r.Type === "AWS::IAM::Role",
  );

  it("sets it on the role osls makes for the run", () => {
    expect(name).toBe("grantlink-app-boundary");
    expect(serverless.provider.iam?.role?.permissionsBoundary).toBe(
      `arn:aws:iam::\${aws:accountId}:policy/${String(name)}`,
    );
    // A role named elsewhere would take the function out of osls's role.
    for (const fn of Object.values(serverless.functions ?? {})) {
      expect(fn.role).toBeUndefined();
    }
  });

  it("sets it on every role the stack declares", () => {
    expect(declared.map(([logical]) => logical)).toContain("FirstRunRole");
    for (const [logical, role] of declared) {
      expect(role.Properties.PermissionsBoundary, logical).toEqual({
        "Fn::Sub": `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:policy/${String(name)}`,
      });
    }
  });
});

// Writes a CloudFormation value as the ARN or name it becomes, with this
// stack's buckets named and the pseudo parameters filled in, so a bucket
// named by Fn::Join of its parts reads the same as one named by Fn::Sub. A
// value it cannot work out reads as "*", which matches anything (#66).
const account = "the-account";
const privateBucket = `grantlink-text-${account}`;
const pseudo: Record<string, string> = {
  "AWS::AccountId": account,
  "AWS::Partition": "aws",
  "AWS::Region": "eu-west-2",
  "AWS::URLSuffix": "amazonaws.com",
};

function bucketName(resources: Resources, logical: string): string {
  const name = resources[logical]?.Properties.BucketName;
  // CloudFormation names an unnamed bucket after the stack and the resource.
  return name === undefined
    ? `grantlink-prod-${logical.toLowerCase()}-generated`
    : render(resources, name);
}

function variable(resources: Resources, name: string): string {
  const fixed = pseudo[name];
  if (fixed !== undefined) return fixed;
  const [logical = "", attribute] = name.split(".");
  const target = resources[logical];
  if (target === undefined) return "*";
  if (target.Type !== "AWS::S3::Bucket") return `<${name}>`;
  const bucket = bucketName(resources, logical);
  if (attribute === undefined) return bucket;
  return attribute === "Arn" ? `arn:aws:s3:::${bucket}` : "*";
}

function render(resources: Resources, value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "*";
  const entries = Object.entries(value);
  const [key, argument] = entries[0] ?? [];
  if (entries.length !== 1) return "*";
  if (key === "Ref" && typeof argument === "string") {
    return variable(resources, argument);
  }
  if (key === "Fn::GetAtt" && Array.isArray(argument)) {
    return variable(resources, argument.join("."));
  }
  if (key === "Fn::Join" && Array.isArray(argument)) {
    const [separator, parts] = argument as [unknown, unknown];
    if (typeof separator !== "string" || !Array.isArray(parts)) return "*";
    return parts.map((part) => render(resources, part)).join(separator);
  }
  if (key === "Fn::Sub") {
    const [text, vars] = (
      Array.isArray(argument) ? argument : [argument, {}]
    ) as [unknown, Record<string, unknown>];
    if (typeof text !== "string") return "*";
    return text.replace(/\$\{([^}!][^}]*)\}/gu, (_match, name: string) =>
      name in vars ? render(resources, vars[name]) : variable(resources, name),
    );
  }
  return "*";
}

// Keys in the private bucket, under each of its prefixes, another prefix
// and none, to test a NotResource against.
const privateObjects = ["cache/", "eval/", "eval-reports/", "names/", ""].map(
  (prefix) => `arn:aws:s3:::${privateBucket}/${prefix}PMC1.json`,
);

// Whether a resource pattern matches some object in the private bucket,
// whatever its key. The text before the first wildcard must agree with the
// start of the bucket's object ARNs, or name one of them outright.
const bucketObjects = `arn:aws:s3:::${privateBucket}/`;
function coversAnObject(pattern: string): boolean {
  const literal = (pattern.split(/[*?]/u)[0] ?? "").toLowerCase();
  if (literal.length === pattern.length) {
    return literal.startsWith(bucketObjects) && literal !== bucketObjects;
  }
  return literal.startsWith(bucketObjects) || bucketObjects.startsWith(literal);
}
const objectActions = [
  "s3:GetObject",
  "s3:GetObjectVersion",
  "s3:PutObject",
  "s3:DeleteObject",
  "s3:DeleteObjectVersion",
  "s3:RestoreObject",
];

// Whether an Allow reaches the private bucket's objects, reading Action or
// NotAction and Resource or NotResource with their wildcards.
function reachesPrivateObjects(
  resources: Resources,
  statement: Statement,
): boolean {
  if (statement.Effect !== "Allow") return false;
  const action =
    statement.NotAction === undefined
      ? list(statement.Action).some((pattern) =>
          objectActions.some((a) => wildcardMatches(pattern, a)),
        )
      : objectActions.some(
          (a) => !list(statement.NotAction).some((p) => wildcardMatches(p, a)),
        );
  const resource =
    statement.NotResource === undefined
      ? list(statement.Resource)
          .map((r) => render(resources, r))
          .some(coversAnObject)
      : privateObjects.some(
          (o) =>
            !list(statement.NotResource)
              .map((r) => render(resources, r))
              .some((pattern) => wildcardMatches(pattern, o)),
        );
  return action && resource;
}

// Each role's or policy's statements that reach the private bucket's
// objects, by resource. A role that attaches a managed policy from outside
// the stack counts, since the stack cannot show what it grants. A Ref to a
// parameter is from outside the stack too.
function readersOfPrivateObjects(resources: Resources): string[] {
  return Object.entries(resources).flatMap(([logical, r]) => {
    const documents = [
      r.Properties.PolicyDocument,
      ...list(r.Properties.Policies).map(
        (policy) => (policy as { PolicyDocument?: unknown }).PolicyDocument,
      ),
    ].filter((d): d is PolicyDocument => d !== undefined);
    const reaching = documents
      .flatMap((d) => list<Statement>(d.Statement))
      .some((statement) => reachesPrivateObjects(resources, statement));
    const outside = list(r.Properties.ManagedPolicyArns).some(
      (arn) =>
        !(
          typeof arn === "object" &&
          arn !== null &&
          "Ref" in arn &&
          typeof arn.Ref === "string" &&
          resources[arn.Ref]?.Type === "AWS::IAM::ManagedPolicy"
        ),
    );
    return reaching || outside ? [logical] : [];
  });
}

// The stack's two buckets, for a test stack to add a resource to.
const buckets: Resources = {
  TextBucket: appStack.Resources.TextBucket as Resources[string],
  SiteBucket: appStack.Resources.SiteBucket as Resources[string],
};

describe("fitness: only the run's own role reaches the private bucket's objects (storage.md)", () => {
  // osls makes the run's role from provider.iam.role, which this does not
  // read. Every other role and policy in the stack is here.
  it("finds no other role or policy that may read or write them", () => {
    expect(readersOfPrivateObjects(appStack.Resources as Resources)).toEqual(
      [],
    );
  });

  const role = (statement: Statement): Resources => ({
    ...buckets,
    Reader: {
      Type: "AWS::IAM::Role",
      Properties: {
        Policies: [
          { PolicyDocument: { Version: "2012-10-17", Statement: [statement] } },
        ],
      },
    },
  });
  const allow = (Resource: unknown): Statement => ({
    Effect: "Allow",
    Action: "s3:GetObject",
    Resource,
  });

  it.each([
    [
      "Fn::Join of its parts",
      {
        "Fn::Join": [
          "",
          [
            "arn:",
            { Ref: "AWS::Partition" },
            ":s3:::grantlink-",
            "text-",
            { Ref: "AWS::AccountId" },
            "/cache/*",
          ],
        ],
      },
    ],
    [
      "Fn::Join with the bucket's Ref",
      { "Fn::Join": ["", ["arn:aws:s3:::", { Ref: "TextBucket" }, "/*"]] },
    ],
    ["the bucket's Arn", { "Fn::Sub": "${TextBucket.Arn}/eval/*" }],
    [
      "Fn::Sub with a variable",
      {
        "Fn::Sub": [
          "arn:aws:s3:::${Name}/*",
          { Name: { "Fn::Sub": "grantlink-text-${AWS::AccountId}" } },
        ],
      },
    ],
    ["a wildcard", "*"],
    ["something it cannot read", { "Fn::ImportValue": "elsewhere" }],
    ["a prefix outside the three", { "Fn::Sub": "${TextBucket.Arn}/names/*" }],
    ["a key at the top", { "Fn::Sub": "${TextBucket.Arn}/PMC1.json" }],
  ])("finds a role that names the bucket by %s", (_how, Resource) => {
    expect(readersOfPrivateObjects(role(allow(Resource)))).toEqual(["Reader"]);
  });

  it("finds an Allow by NotAction or NotResource", () => {
    expect(
      readersOfPrivateObjects(
        role({ Effect: "Allow", NotAction: "iam:*", Resource: "*" }),
      ),
    ).toEqual(["Reader"]);
    expect(
      readersOfPrivateObjects(
        role({
          Effect: "Allow",
          Action: "s3:*",
          NotResource: "arn:aws:s3:::grantlink-prod-*",
        }),
      ),
    ).toEqual(["Reader"]);
  });

  it("finds a role that attaches a managed policy from outside the stack", () => {
    expect(
      readersOfPrivateObjects({
        Reader: {
          Type: "AWS::IAM::Role",
          Properties: {
            ManagedPolicyArns: [
              "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
            ],
          },
        },
      }),
    ).toEqual(["Reader"]);
  });

  it("finds a role that attaches a managed policy by a Ref to a parameter", () => {
    expect(
      readersOfPrivateObjects({
        Reader: {
          Type: "AWS::IAM::Role",
          Properties: { ManagedPolicyArns: [{ Ref: "PolicyArn" }] },
        },
      }),
    ).toEqual(["Reader"]);
  });

  it("passes a role that attaches the stack's own managed policy", () => {
    expect(
      readersOfPrivateObjects({
        SiteBucket: appStack.Resources.SiteBucket as Resources[string],
        Publish: {
          Type: "AWS::IAM::ManagedPolicy",
          Properties: {
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [allow({ "Fn::Sub": "${SiteBucket.Arn}/*" })],
            },
          },
        },
        Reader: {
          Type: "AWS::IAM::Role",
          Properties: { ManagedPolicyArns: [{ Ref: "Publish" }] },
        },
      }),
    ).toEqual([]);
  });

  it("passes a Deny, another bucket and a bucket-level action", () => {
    expect(
      readersOfPrivateObjects(
        role({ Effect: "Deny", Action: "s3:*", Resource: "*" }),
      ),
    ).toEqual([]);
    expect(
      readersOfPrivateObjects(
        role(allow({ "Fn::Sub": "${SiteBucket.Arn}/*" })),
      ),
    ).toEqual([]);
    expect(
      readersOfPrivateObjects(
        role({
          Effect: "Allow",
          Action: "s3:GetBucketPolicy",
          Resource: { "Fn::GetAtt": ["TextBucket", "Arn"] },
        }),
      ),
    ).toEqual([]);
  });
});

// The stack resource a value names by Ref, Fn::GetAtt or a lone Fn::Sub
// variable, if it names one.
function named(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.Ref === "string") return v.Ref;
  const getAtt = v["Fn::GetAtt"];
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") return getAtt[0];
  const sub = v["Fn::Sub"];
  const match =
    typeof sub === "string" ? /^\$\{([^}.!]+)(\.[^}]*)?\}$/u.exec(sub) : null;
  return match?.[1];
}

// Each access point in the stack that opens a route to the private bucket,
// by resource. An access point keeps its own policy, which names its own
// ARN, so the role check above does not see what it grants (#105). The app
// needs none, so the stack may declare none on the private bucket. A bucket
// it cannot work out counts as the private bucket.
function accessPointsOnPrivateBucket(resources: Resources): string[] {
  // A resource other than a bucket renders as `<Name>`, a bucket it cannot
  // work out, since no bucket name holds `<`.
  const onPrivate = (bucket: unknown): boolean => {
    const name = render(resources, bucket);
    return name.includes("<") || wildcardMatches(name, privateBucket);
  };
  const pointOnPrivate = (logical: string): boolean => {
    const r = resources[logical];
    if (r === undefined) return false;
    if (r.Type === "AWS::S3::AccessPoint")
      return onPrivate(r.Properties.Bucket);
    if (r.Type === "AWS::S3::MultiRegionAccessPoint") {
      return list(r.Properties.Regions).some((region) =>
        onPrivate((region as { Bucket?: unknown }).Bucket),
      );
    }
    if (r.Type === "AWS::S3ObjectLambda::AccessPoint") {
      // It reads through a supporting access point. Only one the stack
      // declares on another bucket is safe.
      const configuration = r.Properties.ObjectLambdaConfiguration as
        { SupportingAccessPoint?: unknown } | undefined;
      const supporting = named(configuration?.SupportingAccessPoint);
      return (
        supporting === undefined ||
        resources[supporting]?.Type !== "AWS::S3::AccessPoint" ||
        pointOnPrivate(supporting)
      );
    }
    return false;
  };
  return Object.keys(resources).filter(pointOnPrivate);
}

describe("fitness: no access point opens the private bucket (storage.md)", () => {
  it("finds none in the app stack", () => {
    expect(
      accessPointsOnPrivateBucket(appStack.Resources as Resources),
    ).toEqual([]);
  });

  const withBucket = (extra: Resources): Resources => ({
    ...buckets,
    ...extra,
  });
  const accessPoint = (Bucket: unknown): Resources[string] => ({
    Type: "AWS::S3::AccessPoint",
    Properties: { Bucket },
  });
  const multiRegion = (Bucket: unknown): Resources[string] => ({
    Type: "AWS::S3::MultiRegionAccessPoint",
    Properties: { Regions: [{ Bucket }] },
  });
  const objectLambda = (SupportingAccessPoint: unknown): Resources[string] => ({
    Type: "AWS::S3ObjectLambda::AccessPoint",
    Properties: { ObjectLambdaConfiguration: { SupportingAccessPoint } },
  });

  it.each([
    ["by its Ref", accessPoint({ Ref: "TextBucket" })],
    [
      "by its name",
      accessPoint({ "Fn::Sub": "grantlink-text-${AWS::AccountId}" }),
    ],
    [
      "by a bucket it cannot read",
      accessPoint({ "Fn::ImportValue": "elsewhere" }),
    ],
    ["as a multi-region access point", multiRegion({ Ref: "TextBucket" })],
  ])("finds an access point on the private bucket %s", (_what, point) => {
    expect(accessPointsOnPrivateBucket(withBucket({ Point: point }))).toEqual([
      "Point",
    ]);
  });

  it("finds an access point on a bucket another resource names", () => {
    expect(
      accessPointsOnPrivateBucket(
        withBucket({
          Maker: { Type: "Custom::BucketMaker", Properties: {} },
          Point: accessPoint({ "Fn::GetAtt": ["Maker", "BucketName"] }),
        }),
      ),
    ).toEqual(["Point"]);
  });

  it("finds an Object Lambda access point that reads the private bucket", () => {
    expect(
      accessPointsOnPrivateBucket(
        withBucket({
          Point: accessPoint({ Ref: "TextBucket" }),
          Lambda: objectLambda({ "Fn::GetAtt": ["Point", "Arn"] }),
        }),
      ),
    ).toEqual(["Point", "Lambda"]);
  });

  it("finds an Object Lambda access point whose supporting point it cannot trace", () => {
    expect(
      accessPointsOnPrivateBucket(
        withBucket({
          Lambda: objectLambda(
            "arn:aws:s3:eu-west-2:the-account:accesspoint/elsewhere",
          ),
        }),
      ),
    ).toEqual(["Lambda"]);
  });

  it("passes access points on another bucket", () => {
    expect(
      accessPointsOnPrivateBucket(
        withBucket({
          Point: accessPoint({ Ref: "SiteBucket" }),
          Region: multiRegion({ Ref: "SiteBucket" }),
          Lambda: objectLambda({ "Fn::GetAtt": ["Point", "Arn"] }),
        }),
      ),
    ).toEqual([]);
  });
});
