import { parse, type CollectionTag, type ScalarTag } from "yaml";
import { readRepoFile } from "./repo.ts";

// Reads a CloudFormation template from the repo, turning each short-form
// intrinsic such as `!Sub` into the long form `{ "Fn::Sub": ... }`, so a
// test reads what CloudFormation reads.
const functions = [
  "And",
  "Base64",
  "Cidr",
  "Equals",
  "FindInMap",
  "GetAZs",
  "If",
  "ImportValue",
  "Join",
  "Not",
  "Or",
  "Select",
  "Split",
  "Sub",
];

function longName(name: string): string {
  return name === "Ref" || name === "Condition" ? name : `Fn::${name}`;
}

function tagsFor(name: string): (ScalarTag | CollectionTag)[] {
  const key = longName(name);
  // A GetAtt splits at its first dot only: `Db.Endpoint.Address` names the
  // attribute `Endpoint.Address`.
  const scalar: ScalarTag["resolve"] = (value) => {
    if (name !== "GetAtt") return { [key]: value };
    const [resourceName, ...attribute] = value.split(".");
    return { [key]: [resourceName, attribute.join(".")] };
  };
  const collection: CollectionTag["resolve"] = (value) => ({
    [key]: value.toJSON() as unknown,
  });
  return [
    { tag: `!${name}`, resolve: scalar },
    { tag: `!${name}`, collection: "seq", resolve: collection },
    { tag: `!${name}`, collection: "map", resolve: collection },
  ];
}

const customTags = [...functions, "Ref", "Condition", "GetAtt"].flatMap(
  tagsFor,
);

export interface Statement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Principal?: unknown;
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: unknown;
  NotResource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

export interface PolicyDocument {
  Version: string;
  Statement: Statement[];
}

export interface Resource {
  Type: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties: Record<string, unknown>;
}

export interface Template {
  Parameters?: Record<string, Record<string, unknown>>;
  Resources: Record<string, Resource>;
  Outputs?: Record<string, { Value: unknown }>;
}

export function parseTemplate(text: string): Template {
  return parse(text, { customTags }) as Template;
}

export function readTemplate(path: string): Template {
  return parseTemplate(readRepoFile(path));
}

export function resource(template: Template, name: string): Resource {
  const found = template.Resources[name];
  if (found === undefined) throw new Error(`${name} is not in the template`);
  return found;
}

export function list<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// A role's trust policy and every statement of its inline policies.
export function trustOf(role: Resource): Statement[] {
  return (role.Properties.AssumeRolePolicyDocument as PolicyDocument).Statement;
}

export function rightsOf(role: Resource): Statement[] {
  const policies = (role.Properties.Policies ?? []) as {
    PolicyDocument: PolicyDocument;
  }[];
  return policies.flatMap((policy) => policy.PolicyDocument.Statement);
}

// A Sub string as written, with its variables left in, so a test can pin
// an ARN pattern without knowing the account.
export function subText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "Fn::Sub" in value) {
    const sub = value["Fn::Sub"];
    if (typeof sub === "string") return sub;
    if (Array.isArray(sub) && typeof sub[0] === "string") return sub[0];
  }
  return JSON.stringify(value);
}
