// The histories behind RULES_VERSION and PROMPT_VERSION. A history lists each
// version, oldest first, with the issue whose change made it. A bump adds a
// line naming its own issue. Two branches that bump at once then add
// different lines in the same place, and git will not merge the second until
// it is renumbered, so a version names one set of rules or one prompt (#414).
// Earlier versions predate the histories, which start at the version in force
// when they were added.

export interface Version {
  readonly number: number;
  readonly issue: number;
}

// The last version in a history, as `<prefix>-<number>`. Refuses a history
// that skips or repeats a number, or names an issue twice, so a bump that
// copies the line before it fails as soon as the module loads.
export function latest(prefix: string, history: readonly Version[]): string {
  const last = history.at(-1);
  if (last === undefined) {
    throw new Error(`${prefix} has no version`);
  }
  const issues = new Set<number>();
  history.forEach((version, index) => {
    const before = history[index - 1];
    if (before !== undefined && version.number !== before.number + 1) {
      throw new Error(
        `${prefix}-${String(version.number)} does not follow ${prefix}-${String(before.number)}`,
      );
    }
    if (issues.has(version.issue)) {
      throw new Error(
        `#${String(version.issue)} made two versions of ${prefix}`,
      );
    }
    issues.add(version.issue);
  });
  return `${prefix}-${String(last.number)}`;
}
