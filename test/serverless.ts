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

// The keys an inline entry may hold. The static checks read each of them
// from the merged stack.
const READ_KEYS = ["Parameters", "Resources", "Outputs"];

// Each entry of serverless.yml's `resources` that the static checks would
// not read: `extensions`, any key but the three above, and any template but
// the known ones, each listed once. Entries count from 1.
export function unreadResources(
  resources: unknown,
  templates: readonly string[],
): string[] {
  if (!Array.isArray(resources)) return ["resources is not a list"];
  const known = new Set(templates.map((path) => `\${file(./${path})}`));
  const seen = new Set<string>();
  return resources.flatMap((entry: unknown, index): string[] => {
    const at = `entry ${String(index + 1)}`;
    if (typeof entry === "string") {
      if (!known.has(entry)) return [`${at} is ${entry}`];
      if (seen.has(entry)) return [`${at} is ${entry} again`];
      seen.add(entry);
      return [];
    }
    if (!isPlain(entry)) return [`${at} is not a map`];
    return Object.keys(entry)
      .filter((key) => !READ_KEYS.includes(key))
      .map((key) => `${at} has ${key}`);
  });
}
