---
name: pr-description
description: "Write or rewrite a pull request title and body that a reviewer can read in one screen. Use when raising or updating a pull request (pre-push step 5 points here), or when asked to tidy a description."
---

# Pull request description

## Who reads it

Governor's review, which merges a pull request it passes, the owner, and
anyone reading this public repo afterwards. None of them reads the diff
first. They want to know whether the change is going the right way: is it
more complicated than it needs to be, and has it drifted from what the issue, the PRD or a decision record said. Nothing
already decided there is argued again here.

The body is also the record the next session reads to learn what the
system now is.

## Inputs

Fill it from the diff, the issue and the constraint files the change
touched. Do not fill it from memory of the session. Read the diff once
more before writing, and read the issue again from GitHub: an issue edited
after you picked it up changes what the pull request must meet.

## Title

Imperative and specific. It says what changes, and for whom. "Refuse an
ask whose link is not https", not "Fix link validation".

## Body

Use `.github/pull_request_template.md`. Fill every section, strip the
comments, and add no sections. Aim for about 200 words before *Left for
later*. Every sentence must make sense to someone who has not opened the
diff.

**Outcome.** Two or three sentences. What is true after merge that was not
before, for a user, an agent or a developer. State the effect, not the
diagnosis.

**Adds / removes.** One line per thing the system gains or loses: a
module, a route, a tool field, a dependency, a permission, a stored item,
a test tier. Removals count. Then one net line: simpler or more complex,
and what the complexity buys. Never "nothing" when a new mechanism exists.

**Drift.** Only where the pull request departs from the issue's acceptance
criteria, the PRD, a decision record, or the obvious approach, and why. A
criterion met differently from its wording goes here, first. "Matches #N
as written" when there is none.

**Closing keywords.** Only the `Closes #N` line at the top puts a closing
word next to an issue number. GitHub matches close, fix or resolve plus
`#N` anywhere in the body and reads no negation, so "does not fix #N"
closes it. Write "#N is not addressed here".

**Verification.** A table with one row per acceptance criterion of each
issue this closes. Every criterion gets a row, including ones nothing
answers yet. The rows come from the issue, never from what the session
chose to test.

`Green at` is one of:

- `merge`: a gate test answers it.
- `deploy`: the deploy's live check, which reads the page after each
  deploy, answers it.
- `eval`: the eval report filed for the pull request's fingerprint answers
  it. Name the report's run.
- `by hand`: only the owner can check it, such as a session a real ticket
  starts, or an alarm email arriving. Say exactly what to do.
- an issue number: nothing answers it yet, and that issue owns it. The
  number appears again under *Left for later*.

A dash is not a value. Below the table, say what was not checked and why,
one line each.

**Left for later.** One line per issue filed, with its number and why it
waits. "None" when there is nothing.

## Not in the body

- The story of the work. No "failing test first" or "the review found".
- Test counts, line numbers, commit hashes. A number goes in only when it
  changes what the reader decides.
- A file list. The diff has it.
- A defence of a choice nobody would question.
- A restatement of the PRD or a decision record. Link it, or say where
  this departs from it.

Run the `unslop` skill over the result.

## Self-check

1. Could a reader who has not opened the diff say in one sentence what
   this adds to the system and what it costs?
2. Is the first sentence of *Drift* the thing most likely to make the
   owner stop the merge?
3. Does every acceptance criterion appear in the table, and does every
   row that is not green at merge say who checks it or which issue owns it?

## Example

An illustration of the shape, not a real pull request.

> Closes #40
>
> ## Outcome
> A paper whose funding text names CRUK only in a declared interest is no
> longer counted as CRUK funded. The rules pass reads the sentence a
> reference sits in and skips one that declares an interest.
>
> ## Adds / removes
> - Adds a declared-interest check to the rules pass.
> - Net: one more rule. No new store, field or permission.
>
> ## Drift
> Matches #40 as written.
>
> ## Verification
> | Acceptance criterion | Answered by | Green at |
> |---|---|---|
> | A declared interest is not counted as funding | `src/extract/rules.test.ts` | merge |
> | Precision on gold set B does not fall | The report for this pull request's fingerprint | eval |
> | The live page's counts drop by the papers it no longer counts | The owner compares the counts before and after the deploy | by hand |
>
> ## Left for later
> None.
