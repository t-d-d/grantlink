import { createRequire } from "node:module";
import { z } from "zod";

// How osls builds the app stack from serverless.yml's `resources` list
// (#142). It merges the list's entries in order, objects key by key and
// lists item by item, and then applies `extensions`. The static checks
// rebuild the stack the same way for what they read, and refuse whatever
// they do not read.

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function mergeValue(target: unknown, source: unknown): unknown {
  if (isPlain(target) && isPlain(source)) return mergeOver(target, source);
  if (Array.isArray(target) && Array.isArray(source)) {
    const merged: unknown[] = structuredClone(target as unknown[]);
    source.forEach((item, index) => {
      if (item === undefined) return;
      merged[index] =
        index < target.length
          ? mergeValue(target[index], item)
          : structuredClone(item);
    });
    return merged;
  }
  return structuredClone(source);
}

// A copy of `target` with `source` merged over it, as osls's
// merge-plain-objects does. Neither input changes.
export function mergeOver<T extends object>(target: T, source: object): T {
  const merged = structuredClone(target) as Plain;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    merged[key] = Object.hasOwn(merged, key)
      ? mergeValue(merged[key], value)
      : structuredClone(value);
  }
  return merged as T;
}

// The keys an inline entry may hold. Each merges into the stack test/app.ts
// builds, as osls merges it into the deployed one.
const READ_KEYS = ["Parameters", "Resources", "Outputs"];

// What the app stack declares besides serverless.yml's inline entries: the
// templates' resources, and the functions osls makes resources for.
export interface DeclaredElsewhere {
  declared: readonly string[];
  functions: readonly string[];
}

// The logical ids osls gives what it generates: one fixed set for the
// service, and ids that start with a function's name, normalized as osls
// normalizes it or as written. Event sources the app does not use name
// theirs by these heads or tails too (osls's lib/plugins/aws/lib/naming.js).
const OSLS_HEADS = [
  "ApiGateway",
  "CloudFront",
  "CodeDeploy",
  "CognitoUserPool",
  "Custom",
  "HttpApi",
  "IamRole",
  "S3Bucket",
  "SNSTopic",
  "Serverless",
  "Websockets",
];
const OSLS_TAILS = ["EventBridgeEventBus", "EventBridgeRule", "LambdaLayer"];

function normalizedName(name: string): string {
  const replaced = name.replace(/-/gu, "Dash").replace(/_/gu, "Underscore");
  return replaced.charAt(0).toUpperCase() + replaced.slice(1);
}

export function oslsGenerates(
  logicalId: string,
  functions: readonly string[],
): boolean {
  const heads = [
    ...OSLS_HEADS,
    ...functions.flatMap((name) => [name, normalizedName(name)]),
  ];
  return (
    heads.some((head) => logicalId.startsWith(head)) ||
    OSLS_TAILS.some((tail) => logicalId.endsWith(tail))
  );
}

// osls's own parser for its variables, so a check finds each variable as
// osls finds it, in a fallback, a parameter or an address too.
const parseVariables = createRequire(import.meta.url)(
  "osls/lib/configuration/variables/parse.js",
) as (value: string) => unknown;

interface Source {
  type: string;
  params?: { variables?: Variable[] | undefined }[] | undefined;
  address?: { variables?: Variable[] | undefined } | undefined;
}
interface Variable {
  sources?: Source[] | undefined;
}
const Variable: z.ZodType<Variable> = z.lazy(() =>
  z.object({ sources: z.array(Source).optional() }),
);
const Source: z.ZodType<Source> = z.lazy(() =>
  z.object({
    type: z.string(),
    params: z
      .array(z.object({ variables: z.array(Variable).optional() }))
      .optional(),
    address: z.object({ variables: z.array(Variable).optional() }).optional(),
  }),
);
const Variables = z.array(Variable).nullable();

function sourcesIn(variables: Variable[]): string[] {
  return variables.flatMap((variable) =>
    (variable.sources ?? []).flatMap((source) => [
      source.type,
      ...sourcesIn(source.params?.flatMap((p) => p.variables ?? []) ?? []),
      ...sourcesIn(source.address?.variables ?? []),
    ]),
  );
}

// The variable sources an inline entry may use: the dns stack's outputs and
// the deploy's environment. Any other, such as ${file()} or ${self:}, would
// bring in what the static checks do not read.
const ALLOWED_SOURCES = ["cf", "env"];

// Each source but those above in a string, as osls parses it.
function strayVariables(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseVariables(text);
  } catch {
    return ["a variable osls cannot parse"];
  }
  return [...new Set(sourcesIn(Variables.parse(parsed) ?? []))]
    .filter((type) => !ALLOWED_SOURCES.includes(type))
    .map((type) => `a variable from ${type}`);
}

// Each stray variable in a value, its keys included, with where it sits.
function variablesIn(value: unknown, path: string[]): string[] {
  const at = (found: string[], where: string[]): string[] =>
    found.map((what) => `${what} at ${where.join(".") || "the top"}`);
  if (typeof value === "string") return at(strayVariables(value), path);
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      variablesIn(item, [...path, String(index)]),
    );
  }
  if (isPlain(value)) {
    return Object.entries(value).flatMap(([key, item]) => [
      ...at(strayVariables(key), path),
      ...variablesIn(item, [...path, key]),
    ]);
  }
  return [];
}

// Each entry of serverless.yml's `resources` that the static checks would
// not read: the known templates missing from the head of the list or out of
// order, `extensions`, any key but the three above, and any template but
// the known ones, each listed once. test/app.ts merges the templates first,
// so they must come first. An inline entry may add resources but not change
// one a template declares or osls generates, since osls merges it over
// them and the checks that filter by Type would miss the merged one (#166).
// It may use no variable but the cf and env ones. Entries count from 1.
export function unreadResources(
  resources: unknown,
  templates: readonly string[],
  elsewhere: DeclaredElsewhere,
): string[] {
  if (!Array.isArray(resources)) return ["resources is not a list"];
  const files = templates.map((path) => `\${file(./${path})}`);
  const known = new Set(files);
  const head = files.flatMap((file, index): string[] =>
    resources[index] === file
      ? []
      : [`entry ${String(index + 1)} is not ${file}`],
  );
  const rest = resources
    .slice(files.length)
    .flatMap((entry: unknown, offset): string[] => {
      const at = `entry ${String(files.length + offset + 1)}`;
      if (typeof entry === "string") {
        return [
          known.has(entry) ? `${at} is ${entry} again` : `${at} is ${entry}`,
        ];
      }
      if (!isPlain(entry)) return [`${at} is not a map`];
      const keys = Object.keys(entry)
        .filter((key) => !READ_KEYS.includes(key))
        .map((key) => `${at} has ${key}`);
      const inline = isPlain(entry.Resources) ? entry.Resources : {};
      const changed = Object.keys(inline).flatMap((id): string[] => {
        if (elsewhere.declared.includes(id))
          return [`${at} changes ${id}, which a template declares`];
        if (oslsGenerates(id, elsewhere.functions))
          return [`${at} changes ${id}, which osls generates`];
        return [];
      });
      const variables = variablesIn(entry, []).map(
        (found) => `${at} has ${found}`,
      );
      return [...keys, ...changed, ...variables];
    });
  return [...head, ...rest];
}
