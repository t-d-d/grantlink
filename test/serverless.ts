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

// Each entry of serverless.yml's `resources` that the static checks would
// not read: the known templates missing from the head of the list or out of
// order, `extensions`, any key but the three above, and any template but
// the known ones, each listed once. test/app.ts merges the templates first,
// so they must come first. Entries count from 1.
export function unreadResources(
  resources: unknown,
  templates: readonly string[],
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
      return Object.keys(entry)
        .filter((key) => !READ_KEYS.includes(key))
        .map((key) => `${at} has ${key}`);
    });
  return [...head, ...rest];
}
