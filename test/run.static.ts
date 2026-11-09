import { describe, expect, it } from "vitest";
import { serverless, site } from "./app.ts";
import {
  list,
  readTemplate,
  resource,
  rightsOf,
  subText,
  trustOf,
  type PolicyDocument,
  type Statement,
} from "./cfn.ts";
import { readRepoFile } from "./repo.ts";

// The run's resources in the app stack (#19): the results table and the
// funding text bucket from infra/data.cfn.yml, and the function and its
// first run from serverless.yml.

export const DATA_TEMPLATE = "infra/data.cfn.yml";
const data = readTemplate(DATA_TEMPLATE);

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
  const bucket = resource(data, "TextBucket").Properties;

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

  it("is encrypted with S3's own keys", () => {
    expect(bucket.BucketEncryption).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    });
  });

  it("refuses plain HTTP", () => {
    const policy = resource(data, "TextBucketPolicy").Properties
      .PolicyDocument as {
      Statement: { Effect: string; Condition?: unknown }[];
    };
    expect(policy.Statement).toContainEqual(
      expect.objectContaining({
        Effect: "Deny",
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      }),
    );
  });

  // The deploy role may put any policy on this bucket (#59), so the
  // template is where a policy granting funding text would show.
  it("has a policy that only denies, so it grants no one its objects", () => {
    const appStack: Resources = {
      ...site.Resources,
      ...data.Resources,
      ...inlineResources,
    };
    const onTextBucket = Object.entries(appStack).filter(
      ([, r]) =>
        r.Type === "AWS::S3::BucketPolicy" &&
        /TextBucket|grantlink-text/u.test(JSON.stringify(r.Properties.Bucket)),
    );
    expect(onTextBucket.map(([name]) => name)).toEqual(["TextBucketPolicy"]);
    for (const [name, policy] of onTextBucket) {
      const document = policy.Properties.PolicyDocument as PolicyDocument;
      // CloudFormation takes a lone statement as well as a list.
      for (const statement of list<Statement>(document.Statement)) {
        expect(statement.Effect, `${name} ${statement.Sid ?? ""}`).toBe("Deny");
      }
    }
  });
});

describe("fitness: one on-demand table (storage.md)", () => {
  it("bills on demand, keyed by PMCID", () => {
    const table = resource(data, "ResultsTable").Properties;
    expect(table.BillingMode).toBe("PAY_PER_REQUEST");
    expect(table.KeySchema).toEqual([
      { AttributeName: "pmcid", KeyType: "HASH" },
    ]);
    expect(
      Object.values(data.Resources).filter(
        (r) => r.Type === "AWS::DynamoDB::Table",
      ),
    ).toHaveLength(1);
  });
});

describe("fitness: a run is a durable function on a published version (durable-execution.md)", () => {
  it("is a durable function, which osls publishes as a version behind an alias", () => {
    expect(run.handler).toBe("src/run/lambda.handler");
    expect(run.durableConfig?.executionTimeout).toBeGreaterThan(900);
  });

  it("is started by a one-time schedule, at the alias, never $LATEST", () => {
    expect(run.events ?? []).toEqual([]);
    const schedule = inlineResources.FirstRunSchedule;
    expect(schedule?.Type).toBe("AWS::Scheduler::Schedule");
    const props = schedule?.Properties as {
      ScheduleExpression: string;
      Target: { Arn: unknown };
    };
    expect(props.ScheduleExpression).toBe("at(${env:FIRST_RUN_AT})");
    expect(props.Target.Arn).toEqual({ Ref: "RunDurableLambdaAlias" });
  });

  it("lets the schedule invoke only the alias", () => {
    const role = inlineResources.FirstRunRole as Parameters<typeof trustOf>[0];
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

  it("may write funding text only under cache/, and publish only the page and its data", () => {
    const text = readRepoFile("serverless.yml");
    expect(text).toContain("grantlink-text-${AWS::AccountId}/cache/*");
    expect(text).not.toMatch(/grantlink-text-\$\{AWS::AccountId\}\/\*/u);
    expect(text).toContain("/index.html");
    expect(text).toContain("/found.json");
  });
});
