import { parse } from "yaml";
import { readTemplate, type Template } from "./cfn.ts";
import { readRepoFile } from "./repo.ts";

// The app stack: serverless.yml, and the CloudFormation template it takes
// its resources from (#4, #17).
export interface ServerlessConfig {
  service: string;
  provider: {
    name: string;
    region: string;
    stage: string;
    iam?: {
      deploymentRole?: string;
      role?: {
        permissionsBoundary?: unknown;
        statements?: { Action?: string | string[] }[];
      };
    };
    stackParameters?: { ParameterKey: string; ParameterValue: string }[];
  };
  functions?: Record<string, Record<string, unknown>>;
  resources: unknown;
}

export const serverless = parse(
  readRepoFile("serverless.yml"),
) as ServerlessConfig;

export const SITE_TEMPLATE = "infra/site.cfn.yml";
export const site: Template = readTemplate(SITE_TEMPLATE);

export interface Workflow {
  on: Record<string, unknown>;
  env?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
}

export interface Job {
  name?: string;
  uses?: string;
  secrets?: string | Record<string, string>;
  needs?: string | string[];
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
}

export interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}

export const deploy = parse(
  readRepoFile(".github/workflows/deploy.yml"),
) as Workflow;

export const evalWorkflow = parse(
  readRepoFile(".github/workflows/eval.yml"),
) as Workflow;
