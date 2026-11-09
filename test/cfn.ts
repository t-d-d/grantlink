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
  Conditions?: Record<string, unknown>;
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

// Whether an IAM pattern, with its * and ? wildcards, covers a value, as
// IAM compares actions and ARNs: without regard to case for actions.
export function wildcardMatches(pattern: string, value: string): boolean {
  return new RegExp(
    `^${escapeLiterals(pattern).replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`,
    "iu",
  ).test(value);
}

// Escapes every regular expression character an IAM pattern may hold,
// leaving its * and ? wildcards for the caller to translate.
function escapeLiterals(pattern: string): string {
  return pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
}

// Two characters no ARN holds. They stand for the wildcards in the narrower
// of two patterns: only a * in the wider one can take a *, which may be any
// length, and a * or a ? can take a ?, which is one character.
const anyLength = "\u0000";
const oneCharacter = "\u0001";

// Whether every value one IAM pattern covers is covered by another, as IAM
// compares ARNs: with regard to case.
export function patternWithin(narrow: string, wide: string): boolean {
  return new RegExp(
    `^${escapeLiterals(wide)
      .replace(/\*/gu, "[^]*")
      .replace(/\?/gu, "[^\\u0000]")}$`,
    "u",
  ).test(narrow.replace(/\*/gu, anyLength).replace(/\?/gu, oneCharacter));
}

// Whether some value is covered by both of two IAM patterns.
export function patternsOverlap(a: string, b: string): boolean {
  const seen = new Map<string, boolean>();
  const from = (i: number, j: number): boolean => {
    const key = `${String(i)},${String(j)}`;
    const known = seen.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (i === a.length && j === b.length) result = true;
    else if (a[i] === "*")
      result = from(i + 1, j) || (j < b.length && from(i, j + 1));
    else if (b[j] === "*")
      result = from(i, j + 1) || (i < a.length && from(i + 1, j));
    else if (i === a.length || j === b.length) result = false;
    else
      result =
        (a[i] === b[j] || a[i] === "?" || b[j] === "?") && from(i + 1, j + 1);
    seen.set(key, result);
    return result;
  };
  return from(0, 0);
}

// A statement's resource as an ARN, with each Sub variable and GetAtt Arn
// taken from `names`. It throws on a name it does not know, so a resource
// nobody named for the test cannot pass by accident.
export function renderArn(
  value: unknown,
  names: Record<string, string>,
): string {
  const named = (name: string): string => {
    const found = names[name];
    if (found === undefined) throw new Error(`no ARN for ${name}`);
    return found;
  };
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    if ("Fn::Sub" in value && typeof value["Fn::Sub"] === "string") {
      return value["Fn::Sub"].replace(
        /\$\{([^}]+)\}/gu,
        (_match, name: string) => named(name),
      );
    }
    if ("Fn::GetAtt" in value && Array.isArray(value["Fn::GetAtt"])) {
      const [logicalId, attribute] = value["Fn::GetAtt"] as unknown[];
      if (typeof logicalId === "string" && attribute === "Arn") {
        return named(`${logicalId}.Arn`);
      }
    }
  }
  throw new Error(`cannot render ${JSON.stringify(value)}`);
}
