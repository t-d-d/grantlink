# grantlink

grantlink finds research papers that say Cancer Research UK funded them but that Europe PMC links to no CRUK grant. It reads the grant reference from each paper's funding text and publishes the links at [grantlink.uk](https://grantlink.uk), beside how the service is run: the go/no-go criteria set before the build, the eval that gates every release, and the check behind each limit.

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

- **Gold set A** is 300 papers Europe PMC already links to a CRUK grant that print the grant in their text ([#502](https://github.com/t-d-d/grantlink/issues/502)).
- **Gold set B** is 100 papers it links to none, drawn at random ([sample](docs/gold-set-b-sample.json)). Two passes of a Claude model proposed the labels against [the guide](docs/gold-set-b-guide.md) and the owner checked them ([#175](https://github.com/t-d-d/grantlink/issues/175)), so they may favour a model.
- **Gold set A2** is 300 more papers that nobody tunes on. The rules were tuned on A and B, so A2 shows how they do on new papers ([#695](https://github.com/t-d-d/grantlink/issues/695)).

[eval.yml](.github/workflows/eval.yml) scores the rules alone, then the rules followed by Claude Haiku 5.5 and Claude Sonnet 5.5, on a pinned snapshot of the gold sets' funding text. It runs on every pull request and comments the scores. A report is filed once per fingerprint of the code it scores, and a report below a gating floor fails the pull request's check and stops the deploy ([evals.md](docs/constraints/evals.md), [deploy-gates.md](docs/constraints/deploy-gates.md)). Rules ship alone, and the live service calls no model: neither model added the 10 points ([#330](https://github.com/t-d-d/grantlink/issues/330)). Only [src/extract/model.ts](src/extract/model.ts) calls a model, and it sends only funding text ([model-calls.md](docs/constraints/model-calls.md)).

## How it is built

Each change starts as an issue. Claude Code sessions write the code against it, test first, and `npm run gate` runs format, lint, types and the test tiers, including the fitness functions that hold the constraints. Governor, the owner's review bot, reviews each pull request against [a checklist](.claude/skills/pr-review/SKILL.md) and merges one that passes. Changes to infrastructure, workflows, constraints or the eval wait for the owner.

## How it deploys

[deploy.yml](.github/workflows/deploy.yml) runs on every push to main, and nothing else deploys. It runs the gate and the eval, checks the report clears every floor, and deploys the app stack, `grantlink-prod`, with [osls](https://github.com/oss-serverless/osls) to London (eu-west-2), through a role it assumes by GitHub's OIDC token. It rebuilds the page from the last run's data and checks the live page. The page is static files in a private S3 bucket behind CloudFront.

A failed deploy is fixed forward. To roll back, merge a revert, so main and what is live stay the same ([#127](https://github.com/t-d-d/grantlink/issues/127)). Both data stores are retained.

## How a run works

A run is one Lambda Durable Function execution ([src/run/](src/run/)), started by hand after the first, which the first deploy schedules. It searches Europe PMC for open-access papers since 2020 whose funding or acknowledgement text names CRUK, that are linked to no CRUK grant, and that are not retracted or correction notices. It reads each new paper at about 2 requests a second, keeps only its funding and acknowledgement text in a private bucket, and records each reference the rules find, as written and normalised, in a DynamoDB table. When the rules change, the next run re-runs them on the stored text instead of fetching the paper again. It then publishes the page and its data, `found.json`.

Funding text names people, so it stays in the private bucket and never reaches logs, issues or the page ([personal-data.md](docs/constraints/personal-data.md)). A paper that fails waits for the next run, and a run that fails publishes nothing.

## Setting up the AWS account

Two stacks in [infra/](infra/) are applied once, by hand: the DNS stack, `dns`, with the zone and certificate, and the roles stack, `grantlink-github-oidc`, with GitHub's OIDC provider and every role. Both sit in us-east-1. The account must hold aws-access's `/access/account-id` parameter and no GitHub OIDC provider of its own. With administrator credentials for the account and `gh` signed in with admin rights, run:

```sh
scripts/bootstrap.sh
```

It applies both stacks, printing the zone's nameservers for the registrar while the certificate waits, and gives GitHub the role each job assumes:

| Name | Kind | GitHub environment | Value |
| --- | --- | --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | Secret | `prod` | The roles stack's `DeployRoleArn` output |
| `AWS_EVAL_ROLE_ARN` | Secret | `eval` | The roles stack's `CiEvalRoleArn` output |
| `AWS_CONFORMANCE_ROLE_ARN` | Secret | None, a repository secret | The roles stack's `ConformanceRoleArn` output |

Role ARNs carry the account id, so they are secrets. Jobs find every other value themselves ([#43](https://github.com/t-d-d/grantlink/issues/43)). The script is safe to run again. The gate checks the templates with cfn-lint, pinned in [gate.yml](.github/workflows/gate.yml).

## Pinning an eval snapshot

A run takes the snapshot named in [evals/snapshot.json](evals/snapshot.json) if there is none. To pin it:

```sh
id=$(jq -r .id evals/snapshot.json)
bucket="grantlink-text-$(AWS_PROFILE=grantlink-eval aws sts get-caller-identity --query Account --output text)"
mkdir -p ".eval/eval/$id"
AWS_PROFILE=grantlink-eval aws s3api get-object --bucket "$bucket" --key "eval/$id/manifest.json" ".eval/eval/$id/manifest.json"
node evals/pin.ts .eval
```

and raise the change as a pull request. A session runs the eval with `AWS_PROFILE=grantlink-eval OPENROUTER_KEY=proxy NODE_USE_ENV_PROXY=1 npm run eval`. The proxy adds the real key, the snapshot lands in `.eval/`, which git ignores because it holds funding text, and its runs are advice only.

## Licence

The code is under the Apache License 2.0. The licence covers the code only. Paper titles and funding text belong to their publishers, under each paper's own licence.
