# grantlink

grantlink finds research papers that say Cancer Research UK funded them but that Europe PMC links to no CRUK grant. It reads the grant reference from each paper's funding text and publishes the links at [grantlink.uk](https://grantlink.uk), beside its go/no-go criteria and the live release's scores against them.

It is an independent demonstration on public data from [Europe PMC](https://europepmc.org/), used under the [EMBL-EBI terms of use](https://www.ebi.ac.uk/about/terms-of-use/). It is not affiliated with or endorsed by Cancer Research UK. For corrections or removals, write to thomas.david.dickinson@gmail.com.

The plan is the PRD, [#1](https://github.com/t-d-d/grantlink/issues/1). Decisions are the issues labelled `type: adr`, and the rules in force are in [docs/constraints/](docs/constraints/README.md).

## How a release is gated

The eval scores each release against criteria set before the build:

| Measure | On | Go if | Gates a release |
| --- | --- | --- | --- |
| Precision of accepted links | Gold set B | 95% or more | Yes |
| Recall of true CRUK references | Gold set B | 80% or more | Yes |
| Recall | Gold set A | 95% or more | Yes |
| Papers sent to review | Everything processed | 20% or fewer | No, reported |
| Recall a model adds | Gold set B | 10 points over rules alone | No, it decides the model |
| Model spend | Per 1,000 papers | $5 or less | Yes |

- **Gold set A** is 300 papers that Europe PMC links to a CRUK grant and that print that grant in their text ([#502](https://github.com/t-d-d/grantlink/issues/502)).
- **Gold set B** is 100 papers Europe PMC links to no CRUK grant, with a few of each hard case drawn first ([sample](docs/gold-set-b-sample.json)). Two passes of a Claude model proposed the labels against [the guide](docs/gold-set-b-guide.md). The owner checked 58, accepted the other 42 when a random sample of 10 found no error, and changed none ([#175](https://github.com/t-d-d/grantlink/issues/175)). Because a model proposed them, they may favour a model.
- **Gold set A2** is 300 more papers drawn as A is. The rules were tuned on A and B, never on A2, which is reported and gates nothing ([#695](https://github.com/t-d-d/grantlink/issues/695)).

[eval.yml](.github/workflows/eval.yml) scores the rules alone, then the rules followed by Claude Haiku 5.5 and Claude Sonnet 5.5, on a pinned snapshot of the gold sets' funding text. CI files one report per fingerprint of the code under test and comments its scores on the pull request. A report below a gating floor fails the check and stops the deploy ([evals.md](docs/constraints/evals.md), [deploy-gates.md](docs/constraints/deploy-gates.md)). Until a snapshot is pinned, the gold-set rows wait and block nothing.

The live service calls no model, because Haiku added only 3.9 points of recall and Sonnet 2.9 ([#330](https://github.com/t-d-d/grantlink/issues/330)).

## How it is built

Each change starts as an issue. Claude Code sessions write the code against it, tests first. `npm run gate` runs format, lint, types and the test tiers, including fitness functions that check the constraints. Governor, the owner's review bot, reviews each pull request against [a checklist](.claude/skills/pr-review/SKILL.md) and merges one that passes. A change to infrastructure, workflows, dependencies, scripts, constraints or the eval waits for the owner.

## Access and data

- No AWS keys are stored. Each job assumes a role through GitHub's OIDC token that trusts only its own environment or branch, and every role in the app stack carries a permissions boundary ([#33](https://github.com/t-d-d/grantlink/issues/33)).
- A scheduled conformance job checks the private bucket's settings.
- Funding text names people. It leaves the private bucket only for the eval's model calls, through OpenRouter to Anthropic from [src/extract/model.ts](src/extract/model.ts), and no log, issue or page carries it ([personal-data.md](docs/constraints/personal-data.md), [model-calls.md](docs/constraints/model-calls.md)).

## How it deploys

[deploy.yml](.github/workflows/deploy.yml) runs on every push to main, and nothing else deploys. It runs the gate and the eval, checks the report clears every gating floor, and deploys the app stack, `grantlink-prod` ([serverless.yml](serverless.yml)), with [osls](https://github.com/oss-serverless/osls) to London (eu-west-2). It rebuilds the page, static files in a private S3 bucket behind CloudFront, from the last run's data, then checks the live page ([#44](https://github.com/t-d-d/grantlink/issues/44)).

A failed deploy is fixed forward, and a rollback is a merged revert, so main and what is live stay the same ([#127](https://github.com/t-d-d/grantlink/issues/127)). The stack keeps both data stores if it is deleted or replaced.

## How a run works

A run is one Lambda Durable Function execution ([src/run/](src/run/)). The first deploy schedules the first run, and later runs start by hand. A run searches Europe PMC for open-access papers since 2020 whose funding or acknowledgement text names CRUK. It leaves out papers Europe PMC already links to a CRUK grant, and those it marks as retracted or as correction notices.

The run reads each new paper at about 2 requests a second and keeps only its funding and acknowledgement text in the private bucket. Rules find the references, and a DynamoDB table records each one as written and normalised. When the rules change, the next run applies them to the stored text. The run then publishes the page and its data, `found.json`.

A paper that fails waits for the next run. A run that fails, or finds nothing, publishes nothing. The exception is a run that fails while it publishes. It writes `found.json` before the page, so its data can stay on the site for the next deploy to build from, which is acceptable because it had finished reading ([#79](https://github.com/t-d-d/grantlink/issues/79)).

## Setting up the AWS account

Two stacks in [infra/](infra/) are applied once, by hand, in us-east-1: the DNS stack, `dns`, with the zone and certificate, and the roles stack, `grantlink-github-oidc`, with the OIDC provider, the job roles and the permissions boundary. The account must have no GitHub OIDC provider of its own, and the script checks the rest. With administrator credentials and `gh` signed in with admin rights, run:

```sh
scripts/bootstrap.sh
```

It applies both stacks, printing the zone's nameservers for the registrar while the certificate waits, and gives GitHub the role each job assumes:

| Name | Kind | GitHub environment | Value |
| --- | --- | --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | Secret | `prod` | The roles stack's `DeployRoleArn` output |
| `AWS_EVAL_ROLE_ARN` | Secret | `eval` | The roles stack's `CiEvalRoleArn` output |
| `AWS_CONFORMANCE_ROLE_ARN` | Secret | None, a repository secret | The roles stack's `ConformanceRoleArn` output |

Role ARNs carry the account id, so they are secrets. Until `AWS_DEPLOY_ROLE_ARN` is set, a deploy deploys nothing. Jobs find every other AWS value themselves ([#43](https://github.com/t-d-d/grantlink/issues/43)). The script is safe to run again. The eval's model key, `OPENROUTER_KEY`, is set by hand on the `eval` environment, with its own credit limit ([#328](https://github.com/t-d-d/grantlink/issues/328)). Pinning and running the eval are in [docs/eval-snapshot.md](docs/eval-snapshot.md).

## Licence

The code is under the Apache License 2.0. The licence covers the code only. Paper titles and funding text belong to their publishers, under each paper's own licence.
