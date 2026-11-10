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
// templates' resources and outputs, and the functions osls makes resources
// for.
export interface DeclaredElsewhere {
  declared: readonly string[];
  outputs: readonly string[];
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
const OSLS_TAILS = [
  "ApiGatewayAuthorizer",
  "EventBridgeEventBus",
  "EventBridgeRule",
  "LambdaAuthorizerPermissionHttpApi",
  "LambdaLayer",
  "LambdaLayerPermission",
  "StreamConsumer",
];

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

// A literal fallback, such as 'local' in ${env:X, 'local'}, is a source
// with a value and no type.
interface Source {
  type?: string | undefined;
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
    type: z.string().optional(),
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
      ...(source.type === undefined ? [] : [source.type]),
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

// Each stray variable in a value read from a file, such as a template,
// which osls resolves as it resolves an inline entry.
export function strayVariablesIn(value: unknown): string[] {
  return variablesIn(value, []);
}

// Each YAML merge key in a parsed value, with where it sits. osls reads
// serverless.yml and the templates with js-yaml, which applies a merge,
// while the static checks parse with the yaml package, which by default
// keeps a plain `<<` as an ordinary key and reads a `!!merge` tag on an
// empty key as the key "". Either way a resource whose Type came from a
// merge would pass them untyped. The app uses neither, so the gate refuses
// both (#242). An alias may hold itself, so the walk stops at a value it is
// already inside.
function mergeKeys(
  value: unknown,
  path: string[],
  inside: ReadonlySet<unknown>,
): string[] {
  if (inside.has(value)) return [];
  const within = new Set(inside).add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      mergeKeys(item, [...path, String(index)], within),
    );
  }
  if (!isPlain(value)) return [];
  const where = path.join(".") || "the top";
  return Object.entries(value).flatMap(([key, item]) => [
    ...(key === "<<" ? [`a merge key at ${where}`] : []),
    ...(key === ""
      ? [`an empty key, which osls may read as a merge, at ${where}`]
      : []),
    ...mergeKeys(item, [...path, key], within),
  ]);
}

export function mergeKeysIn(value: unknown): string[] {
  return mergeKeys(value, [], new Set());
}

// Each entry of serverless.yml's `resources` that the static checks would
// not read: the known templates missing from the head of the list or out of
// order, `extensions`, any key but the three above, and any template but
// the known ones, each listed once. test/app.ts merges the templates first,
// so they must come first. An inline entry may add resources but not change
// one a template declares or osls generates, since osls merges it over
// them and the checks that filter by Type would miss the merged one (#166).
// Nor may it change an output a template declares or osls generates, since
// the deploy reads the stack's outputs (#243), or change a resource or an
// output an earlier inline entry declares, which osls would merge over it
// (#261), or a parameter an earlier inline entry declares (#297), or hold a
// section that is not a map, which osls would merge over the whole section.
// No inline parameter may share its name with any resource (#323).
// It may use no variable but the cf and env ones.
// Entries count from 1.
export function unreadResources(
  resources: unknown,
  templates: readonly string[],
  elsewhere: DeclaredElsewhere,
): string[] {
  if (!Array.isArray(resources)) return ["resources is not a list"];
  const files = templates.map((path) => `\${file(./${path})}`);
  const known = new Set(files);
  // The entry that first declares each inline parameter, resource and
  // output.
  const inlineParameters = new Map<string, string>();
  const inlineResources = new Map<string, string>();
  const inlineOutputs = new Map<string, string>();
  // Who declares `id`: a template, osls or an inline entry, or nobody.
  const declarer = (
    id: string,
    declared: readonly string[],
    generated: (id: string) => boolean,
    inline: ReadonlyMap<string, string>,
  ): string | undefined => {
    if (declared.includes(id)) return "a template declares";
    if (generated(id)) return "osls generates";
    const earlier = inline.get(id);
    return earlier === undefined ? undefined : `${earlier} declares`;
  };
  // osls generates resources and outputs, not parameters.
  const byOsls = (id: string): boolean =>
    oslsGenerates(id, elsewhere.functions);
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
      const keys = Object.keys(entry).flatMap((key): string[] => {
        if (!READ_KEYS.includes(key)) return [`${at} has ${key}`];
        return isPlain(entry[key])
          ? []
          : [`${at} has ${key} that is not a map`];
      });
      // Each id in `section` that a template, osls or an earlier inline
      // entry declares. The rest are this entry's, for later entries.
      const changes = (
        section: unknown,
        declared: readonly string[],
        inline: Map<string, string>,
        what: string,
        generated: (id: string) => boolean,
      ): string[] =>
        Object.keys(isPlain(section) ? section : {}).flatMap((id): string[] => {
          const by = declarer(id, declared, generated, inline);
          if (by !== undefined)
            return [`${at} changes ${what}${id}, which ${by}`];
          inline.set(id, at);
          return [];
        });
      // An inline parameter may set a template's parameter, as serverless.yml
      // sets the dns stack's values as defaults, so only an earlier inline
      // entry's parameter counts.
      const changedParameters = changes(
        entry.Parameters,
        [],
        inlineParameters,
        "the parameter ",
        () => false,
      );
      const changed = changes(
        entry.Resources,
        elsewhere.declared,
        inlineResources,
        "",
        byOsls,
      );
      const changedOutputs = changes(
        entry.Outputs,
        elsewhere.outputs,
        inlineOutputs,
        "the output ",
        byOsls,
      );
      const variables = variablesIn(entry, []).map(
        (found) => `${at} has ${found}`,
      );
      return [
        ...keys,
        ...changedParameters,
        ...changed,
        ...changedOutputs,
        ...variables,
      ];
    });
  // A template cannot hold a parameter and a resource under one logical id
  // (#323). Any inline entry's resource counts, earlier or later, since
  // CloudFormation reads the merged stack as a whole.
  const clashes = [...inlineParameters].flatMap(([id, at]): string[] => {
    const by = declarer(id, elsewhere.declared, byOsls, inlineResources);
    return by === undefined
      ? []
      : [`${at} declares the parameter ${id}, which ${by} as a resource`];
  });
  return [...head, ...rest, ...clashes];
}
