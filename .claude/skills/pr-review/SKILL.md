---
name: pr-review
description: The checklist governor's PR review reads for grantlink's pull requests. Use to review a pull request here by hand.
---

# PR review

Read the pull request's description, the names of its changed files and
the tickets it closes, then answer each test in order. The review sees no
diff and reads no source files. The description follows
.github/pull_request_template.md, and the tests follow its sections.

A pass merges the pull request.

## The checklist

1. **Every ticket it closes is open, claimed and not a PRD.** A ticket
   labelled `type: prd` fails. One with neither `claimed` nor `mode: human`
   fails, and so does one another open pull request also closes. Governor
   checks this in code before the model reads anything.

2. **The Outcome is what the tickets it closes asked for.** It says what is
   true after the merge that was not before, and that is what each ticket's
   Change and acceptance criteria describe.

3. **Adds / removes names nothing only the owner can do.** That means a
   secret, a repository variable, the App's settings, the claude.ai login or
   an AWS setting. A line that needs one of them fails.

4. **Drift narrows the tickets, or says why it departs from them.** "Matches
   #N as written" passes when nothing departs. Work the tickets did not ask
   for, with no reason given, fails.

5. **The Verification table answers every acceptance criterion of every
   ticket it closes.** Each criterion has a row saying what answers it and
   where it is green. A criterion only the owner can check, after the merge,
   may say so.

6. **Left for later names an issue for each loose end, or says None.** A
   loose end with no issue number fails.

7. **The change keeps complexity the same or lower, and adds what the
   tickets ask for.** Read the Adds / removes section. It passes when its
   net line says the change is simpler or no more complex, the lines above
   the net line agree, and the Outcome adds what the tickets ask for. It
   fails when the net line says more complex, or when a line above it adds
   a module, a dependency, a config switch or an abstraction that the net
   line does not account for. A fail here says that no edit to the
   description can make the pull request pass, so it waits for the owner.

8. **No changed file is on the human-only list.** The list is
   `prReview.humanOnly` in `.github/governor.json`: the stacks in `infra/`,
   everything under `.github/`, the constraint files in `docs/constraints/`,
   `CLAUDE.md`, `.claude/`, the app stack in `serverless.yml`, the scripts
   in `scripts/` and the live tier in `test/page.live.ts` and
   `test/tiers.ts`, which the deploy job runs with the deploy role's
   credentials, the eval set in `evals/`, and the dependencies in
   `package.json` and `package-lock.json`. A pull request that changes one waits for the owner,
   with the entry's reason. Governor checks this in code.

9. **No required status check is red on its head.** Governor checks this in
   code, and a push that turns the check green meets it.

## Dependabot

A pull request `dependabot[bot]` opened is held to test 8 alone, with the
Dependabot list (`prReview.dependabot` in `.github/governor.json`) in place of
the human-only list. That list is empty here, so every Dependabot pull request
waits for a person.

## The answer

`pass`, or `fail` with the first failed test's number, one sentence saying
what the description would need to state to meet it, and whether any edit to
the description can make the pull request pass.

## By hand

`/pr-review <number>` reads the pull request and reports the answer in the
chat. It posts nothing.
