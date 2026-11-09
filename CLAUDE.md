# Working in this repo

grantlink finds research papers that say Cancer Research UK funded them but that Europe PMC links to no CRUK grant. It reads the grant reference from each paper's funding text, publishes the links, and publishes how the service is run. It is an independent demonstration on public data, with no connection to CRUK.

- The PRD is #1, an issue labelled `type: prd`. There is no PRD file. Its "Non-goals" list is binding: do not build one.
- Decisions and their reasons are issues labelled `type: adr`. [docs/constraints/](docs/constraints/README.md) holds the rules in force.

## Scope

- Work you find in passing becomes an issue. Do not fix it in the branch you are on.

## Before any code edit

- Run the `constraints` skill. The stacks, the workflows, `serverless.yml` and `package.json` count as code.
- If the task conflicts with a constraint, stop and say so. Do not work around the rule, and do not quietly follow the task.
- A change to what a constraint means needs a decision record issue the owner agrees to, linked from the file's History line.

## Tests first

- Write the failing test first. Watch it fail for the reason you expect, then write the code.
- A test's file name sets its tier ([code-and-tests.md](docs/constraints/code-and-tests.md)): `*.static.ts`, `*.test.ts` and `*.int.ts` are in the gate, `*.live.ts` reads the deployed page, and `*.conformance.ts` reads setup outside the repo.
- An assertion goes in the lowest tier that can see it.
- A fitness function's describe name is `fitness: <check> (<file>.md)`.
- Never weaken or delete a test to get the gate green.

## The gate

- `npm run gate` runs everything: format, lint, types and the tiers in the gate. It is the same command in CI, on every pull request and before each deploy from main.
- The gate is offline and holds no secrets.

## The eval

- The eval set comes before the rules or the prompt: write or extend the cases first.
- A change to `src/extract/` or `evals/` changes the eval's fingerprint, and CI runs the eval on the pull request (#9).
- While you iterate, run the eval in the session. The eval key is a network secret for openrouter.ai, so the session never sees it, and the `grantlink-eval` profile reads the snapshot. Your runs are advice. Only CI files the reports that count.

## Branches and pull requests

- Never push to main. One branch per issue.
- Run the `pre-push` skill before every push. It ends by raising the pull request.
- The pull request body follows the `pr-description` skill.
- Nothing deploys except a green merge to main. Never deploy by hand.
- Governor reviews pull requests against `.claude/skills/pr-review/SKILL.md` and merges one that passes. Do not merge your own pull request.
- A pull request waits for the owner when it changes `infra/`, `.github/`, `docs/constraints/`, `CLAUDE.md` or `.claude/`, when it adds, removes or renames a file under `src/`, `evals/`, `test/` or `scripts/`, or when the review finds it adds complexity its tickets do not need.
- When the review fails on the description, fix the description. When it says no edit to the description can make it pass, leave it for the owner.

## Issues

- Given an issue number, run the `fetch-ticket` skill first.
- Labels: `type: …` and `mode: afk`, `mode: hitl` or `mode: human`. An issue is picked up as soon as it is labelled `mode: afk` and its blockers are closed, and goes from its text to a pull request without stopping to ask.
- Blockers are GitHub's own issue dependencies, not lines in the body.
- Anything only the owner can do is not yours: a secret, a repository variable, an AWS setting, the registrar, a GitHub setting. Say what is needed and stop.
- When your pull request has merged or closed, or you are done and have none, make the last line of your reply `Signing off.` or `Signing off: <reason>`. That archives the session. Do not sign off while the owner is working with you.

## Session rules

Governor gives these rules to the sessions it starts. A session a person starts reads them here. Replace the block whole when governor publishes a new version.

<!-- governor:session-rules v1 -->
Rules for every session in this repo:

1. Sign everything you write on GitHub: comments, reviews, replies, and issue and PR bodies, with this session's link, its https://claude.ai/code/session_… URL, alone on the line just above the Claude Code footer. Governor reads the link there to know who wrote a post, so it does not send you your own posts.
2. Only an issue's or a PR's owner edits its body, and only a PR's owner pushes to its branch. You own what you filed or opened, or what governor tells you that you own. Signing off gives up the issues you own. While you own an open PR, do not sign off until governor asks.
3. To change an issue or a PR you do not own, comment on it. Where governor tells you nobody owns an issue, you may take it by editing its body so your link ends it.
<!-- governor:session-rules-end -->

## GitHub and AWS from a cloud session

- Read the `github-tooling` skill before any `gh` command.
- A session reaches AWS only through aws-access's profiles: `grantlink` reads, and `grantlink-eval` reads the eval snapshot. If a task needs more, stop and say so.

## The repo is public

- No file holds an AWS account id, a role ARN that carries one, or a session or installation id. Role ARNs are secrets.
- Funding statements name people. Never paste funding text into an issue, a pull request, a commit or a log ([#10](https://github.com/t-d-d/grantlink/issues/10)).
- Cancer Research UK is named only to say whose grants grantlink reads. No CRUK logo, colours or styling anywhere.

## Writing

- Plain words and whole sentences. No em dashes.
- Run the `unslop` skill over anything a person will read: pull request bodies, issues, docs, the README, and the text on the page.
