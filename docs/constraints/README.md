# Constraints

The rules in force, one file per topic, written as instructions to whoever edits the code next. Where a file here matches your change, it is authoritative. The `constraints` skill reads every file's `Relevance:` line before any code edit.

The decision records that say why each rule exists are issues labelled `type: adr`. A file here says only what must stay true now. The pull request that adds or changes a file closes the decision record behind it.

## Format

Every file has the same parts, in this order.

- **Relevance:** when to read the file, and the paths it covers, on one line.
- **Decision:** the rule in one line of 160 characters or fewer.
- **Why:** the reason, in a few lines.
- **Rules:** what must hold.
- **Do not:** the tempting alternatives that were rejected, each with its reason.
- **Judgment:** optional. What no automated check holds, and how to decide a case the rules do not cover.
- **History:** the decision records behind the file.

## Checks

A rule that a machine can check has a test whose describe name starts `fitness: <check> (<file>.md)`, naming the check and the file. What no check can see goes on the file's `Judgment:` line.

## Changing a constraint

A change to what a rule means needs a decision record issue the owner agrees to, linked from the file's History line. A change of wording only needs none.
