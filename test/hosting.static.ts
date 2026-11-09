import { describe, expect, it } from "vitest";
import { deploy, serverless, site, SITE_TEMPLATE } from "./app.ts";
import { readTemplate, resource } from "./cfn.ts";
import { readRepoFile } from "./repo.ts";

// The app stack runs serverless in London, its own account's only
// environment, and serves the page over HTTPS only (#4).

describe("fitness: data stays in London (hosting.md)", () => {
  it("puts the app stack in eu-west-2", () => {
    expect(serverless.provider.name).toBe("aws");
    expect(serverless.provider.region).toBe("eu-west-2");
  });

  it("names the stack grantlink-prod, the only stack the deploy role may change", () => {
    expect(serverless.service).toBe("grantlink");
    expect(serverless.provider.stage).toBe("prod");
    expect(readRepoFile("infra/github-oidc.cfn.yml")).toContain(
      "cloudformation:eu-west-2:${AWS::AccountId}:stack/grantlink-prod/*",
    );
  });

  it("takes its resources from the site template", () => {
    expect(serverless.resources).toContain(`\${file(./${SITE_TEMPLATE})}`);
  });

  it("deploys with no region or stage given on the command line", () => {
    const runs = Object.values(deploy.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? "");
    const deploys = runs.filter((run) => /\bsls deploy\b/u.test(run));
    expect(deploys).toHaveLength(1);
    expect(deploys[0]).not.toMatch(/--region|--stage|-r |-s /u);
  });
});

describe("fitness: no always-on compute (hosting.md)", () => {
  const alwaysOn = [
    "AWS::EC2::Instance",
    "AWS::EC2::NatGateway",
    "AWS::ECS::Service",
    "AWS::AutoScaling::AutoScalingGroup",
    "AWS::RDS::DBInstance",
    "AWS::RDS::DBCluster",
    "AWS::ElastiCache::CacheCluster",
    "AWS::Lambda::Version",
  ];

  // The app stack is the site and data templates plus anything
  // serverless.yml declares inline beside them.
  const entries: unknown[] = Array.isArray(serverless.resources)
    ? serverless.resources
    : [serverless.resources];
  const inline = entries.flatMap((entry) =>
    typeof entry === "object" && entry !== null && "Resources" in entry
      ? Object.values(
          (entry as { Resources: Record<string, { Type: string }> }).Resources,
        )
      : [],
  );

  it("declares no instance, service, NAT gateway or database server", () => {
    const data = readTemplate("infra/data.cfn.yml");
    const types = [
      ...Object.values(site.Resources),
      ...Object.values(data.Resources),
      ...inline,
    ].map((r) => r.Type);
    expect(types.filter((type) => alwaysOn.includes(type))).toEqual([]);
  });

  it("gives no function provisioned concurrency", () => {
    const text =
      readRepoFile("serverless.yml") +
      readRepoFile(SITE_TEMPLATE) +
      readRepoFile("infra/data.cfn.yml");
    expect(text).not.toMatch(/provisionedConcurrency|ProvisionedConcurrency/u);
  });
});

describe("fitness: HTTPS only (hosting.md)", () => {
  const config = resource(site, "Distribution").Properties
    .DistributionConfig as {
    DefaultCacheBehavior: { ViewerProtocolPolicy: string };
    CacheBehaviors?: { ViewerProtocolPolicy: string }[];
    Origins: {
      S3OriginConfig?: unknown;
      CustomOriginConfig?: unknown;
      OriginAccessControlId?: unknown;
    }[];
  };

  it("redirects every viewer request on plain HTTP to HTTPS", () => {
    const behaviours = [
      config.DefaultCacheBehavior,
      ...(config.CacheBehaviors ?? []),
    ];
    for (const behaviour of behaviours) {
      expect(["redirect-to-https", "https-only"]).toContain(
        behaviour.ViewerProtocolPolicy,
      );
    }
  });

  it("reads the bucket through origin access control, not a website endpoint", () => {
    expect(config.Origins).toHaveLength(1);
    expect(config.Origins[0]?.CustomOriginConfig).toBeUndefined();
    expect(config.Origins[0]?.OriginAccessControlId).toEqual({
      "Fn::GetAtt": ["OriginAccessControl", "Id"],
    });
  });

  it("keeps the bucket private", () => {
    const bucket = resource(site, "SiteBucket").Properties;
    expect(bucket.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket.WebsiteConfiguration).toBeUndefined();
  });

  // With ACLs disabled, no grant can let another account write or change
  // the page's files, whatever the deploy role's s3:PutBucket* allows (#95).
  it("lets no ACL grant access to the bucket", () => {
    const bucket = resource(site, "SiteBucket").Properties;
    expect(bucket.OwnershipControls).toEqual({
      Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
    });
    expect(bucket.AccessControl).toBeUndefined();
  });

  it("tells browsers to keep to HTTPS", () => {
    const policy = resource(site, "ResponseHeaders").Properties
      .ResponseHeadersPolicyConfig as {
      SecurityHeadersConfig: {
        StrictTransportSecurity: {
          Override: boolean;
          AccessControlMaxAgeSec: number;
        };
      };
    };
    const hsts = policy.SecurityHeadersConfig.StrictTransportSecurity;
    expect(hsts.Override).toBe(true);
    expect(hsts.AccessControlMaxAgeSec).toBeGreaterThanOrEqual(31_536_000);
  });
});

describe("the page's address", () => {
  it("serves at grantlink.uk only once the certificate and the zone are given", () => {
    expect(site.Parameters?.DomainName?.Default).toBe("grantlink.uk");
    expect(site.Parameters?.CertificateArn?.Default).toBe("");
    expect(site.Parameters?.HostedZoneId?.Default).toBe("");
    const records = Object.values(site.Resources).filter(
      (r) => r.Type === "AWS::Route53::RecordSet",
    );
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect((record as { Condition?: string }).Condition).toBe("HasDomain");
    }
  });

  it("takes the certificate and the zone from the deploy's environment", () => {
    expect(serverless.resources).toContainEqual({
      Parameters: {
        CertificateArn: { Default: "${env:CERTIFICATE_ARN, ''}" },
        HostedZoneId: { Default: "${env:HOSTED_ZONE_ID, ''}" },
      },
    });
  });

  // osls passes stack parameters to the stack's first create as well, whose
  // template holds only the deployment bucket, and CloudFormation refuses
  // parameters a template does not declare.
  it("passes no stack parameters, so the stack's first create succeeds", () => {
    expect(serverless.provider.stackParameters).toBeUndefined();
  });

  it("builds the stack through the execution role", () => {
    expect(serverless.provider.iam?.deploymentRole).toBe(
      "${env:AWS_DEPLOY_EXECUTION_ROLE_ARN}",
    );
  });
});
