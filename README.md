# grantlink

grantlink finds research papers that say Cancer Research UK funded them but that Europe PMC links to no CRUK grant. It reads the grant reference from each paper's funding text, publishes the links, and publishes how the service is run: the go/no-go criteria set before the build, the evals that gate every release, and the check behind every limit it works within.

It is an independent demonstration on public data from [Europe PMC](https://europepmc.org/). It is not affiliated with or endorsed by Cancer Research UK.

The data comes from Europe PMC, through its public web services, under the [EMBL-EBI terms of use](https://www.ebi.ac.uk/about/terms-of-use/). For corrections or removals, write to thomas.david.dickinson@gmail.com.

The plan is the PRD, [#1](https://github.com/t-d-d/grantlink/issues/1). The decisions behind it are the issues labelled `type: adr`, and the rules in force are in [docs/constraints/](docs/constraints/README.md).

## Setting up the AWS account

Two stacks are applied by hand, once, before anything deploys, and both are code in [infra/](infra/):

- **The DNS stack**, `dns`, from [infra/dns.cfn.yml](infra/dns.cfn.yml): the hosted zone for grantlink.uk and its certificate, in us-east-1, where CloudFront requires the certificate. The zone is kept if the stack is deleted, so its nameservers never change under the registrar.
- **The roles stack**, `grantlink-github-oidc`, from [infra/github-oidc.cfn.yml](infra/github-oidc.cfn.yml): GitHub's OIDC provider, the deploy role and the role CloudFormation takes to build the app stack, `grantlink-app-boundary`, the permissions boundary every role in the app stack must carry, the CI eval role, the conformance role that reads the private bucket's settings, and `access-eval` for aws-access's `grantlink-eval` profile. IAM is global, so it sits in us-east-1 beside the DNS stack. It reads the access account's id from aws-access's `/access/account-id` parameter in us-east-1.

Every later change to the account goes through the app stack, from a green merge to main.

Run one script, from the repo root on your own machine, with AWS credentials for grantlink's account as an administrator, however you come by them, and `gh` signed in with admin rights on this repo. Before it changes anything, the script checks that the account holds aws-access's `/access/account-id` parameter, which the roles stack reads. The account must not already have a GitHub OIDC provider of its own, or the roles stack fails:

```sh
scripts/bootstrap.sh
```

It asks only whether the account is the right one. Then it:

1. Applies the DNS stack, and prints the zone's nameservers as soon as the zone exists. If the registrar does not list them yet, set them there then: the certificate, and so the stack, waits until it does.
2. Applies the roles stack. It takes no parameter a person fills. It reads the access account's id from SSM, and the private bucket is `grantlink-text-<account id>`, the name the app stack (#19) must give it.
3. Gives GitHub the role each job assumes: one per environment, and the conformance role for the repository, since the scheduled conformance job names no environment:

| Name | Kind | GitHub environment | Value |
| --- | --- | --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | Secret | `prod` | The roles stack's `DeployRoleArn` output |
| `AWS_EVAL_ROLE_ARN` | Secret | `eval` | The roles stack's `CiEvalRoleArn` output |
| `AWS_CONFORMANCE_ROLE_ARN` | Secret | None, a repository secret | The roles stack's `ConformanceRoleArn` output |

Role ARNs carry the account id, so they are secrets, never variables. The script reads every value before it gives GitHub any, and stops rather than give an empty one.

4. Removes the values earlier versions of the script set and no jobs read now: `AWS_DEPLOY_EXECUTION_ROLE_ARN`, `CERTIFICATE_ARN`, `HOSTED_ZONE_ID` and `PRIVATE_BUCKET_NAME` in `prod`, and `PRIVATE_BUCKET_NAME` in `eval`. A value that is already gone counts as removed.

Once a job has assumed its role, it finds or builds every other value it needs. The app stack reads the certificate's ARN and the zone's id from the DNS stack, and builds the execution role's ARN from the account and the role's fixed name, `grantlink-deploy-execution`. The eval builds the private bucket's name from the account. GitHub holds no copy of them to go stale (#43).

The script is safe to run again. Each step changes only what differs, and it waits for a stack an earlier run left part way. If the credentials expire while the certificate waits for the registrar, the script stops while the stack carries on. Run it again and it waits for the stack. A stack whose first create failed has to be deleted before a run can apply it, and the script says so.

The deploy role trusts only the `prod` environment and the CI eval role only the `eval` environment, so a workflow job must name its environment to reach either. The conformance role trusts only runs on main in a job that names no environment, and reads the private bucket's public access block, encryption, policy and ownership controls, and nothing the bucket holds. The gate checks both templates with [cfn-lint](https://github.com/aws-cloudformation/cfn-lint), so running the gate locally needs the version CI pins in [gate.yml](.github/workflows/gate.yml) (`pipx install cfn-lint==1.60.0`).

## How it deploys

The app stack, `grantlink-prod`, is defined in [serverless.yml](serverless.yml) and deployed with [osls](https://github.com/oss-serverless/osls), the open-source fork of the Serverless Framework. It runs in London (eu-west-2). It holds the page, the run and the run's stores. The page is files in a private S3 bucket behind CloudFront, served over HTTPS only, with its resources in [infra/site.cfn.yml](infra/site.cfn.yml). The results table and the private bucket for funding text are in [infra/data.cfn.yml](infra/data.cfn.yml).

[deploy.yml](.github/workflows/deploy.yml) runs on every push to main, and nothing else deploys. It runs the gate and the eval, then:

1. Reads whether `AWS_DEPLOY_ROLE_ARN` is set in `prod`. Until the bootstrap above has run, it stops there and deploys nothing.
2. Checks that the eval's report is for main's own fingerprint and clears every gating floor, and records the release in `site/release.json`: its commit, its fingerprint, the report and the run that produced it, and the deploy's own run. A report below a floor stops the deploy, and the page keeps the last release.
3. Assumes the deploy role through GitHub's OIDC token, and masks the account id.
4. Deploys the app stack. The first deploy also sets a one-time schedule that starts the first run a quarter of an hour later.
5. Builds the page again from the release record and the last run's `found.json`, if there is one, copies [site/](site/) to the bucket and clears CloudFront's cache. It uploads `release.json` only once S3 has accepted the page that shows it, and serves it uncached, so the record and the page name the same release (#119).
6. Runs the live tier against the page. A failure turns the deploy red.

CloudFront serves the page at grantlink.uk, with the certificate and the zone the deploy reads from the DNS stack. A deploy before the DNS stack exists fails (#44). A failed deploy is fixed forward. There is no rollback step, and CloudFormation rolls a failed stack update back by itself. To roll back a release, merge a revert to main, which starts a new deploy run. Re-running an older deploy run is not a supported rollback. It puts the older release live while main still holds the newer code, so main and what is live disagree, and the next merge deploys the newer code again. A revert keeps main and what is live the same (#127, #235). Before it deploys, the deploy checks the stack. If the stack is stuck in cleanup or rollback, or the funding text bucket exists outside it, the deploy stops and names the resource and what to do (#89). Both data stores are retained, so no rollback deletes their data.

## How the eval gates a release

[eval.yml](.github/workflows/eval.yml) runs on every pull request, and on main inside the deploy. It computes the eval's fingerprint, the git hashes of `src/extract/`, `src/shared/`, `evals/`, the workflow and the lockfile, and reuses the report filed under it in `eval-reports/` in the private bucket. With no report, it downloads the snapshot, runs [evals/run.ts](evals/run.ts) and files one, written once. A pull request gets a comment with CI's scores beside the live release's. A report below a gating floor fails the job, so the pull request cannot merge once the `eval` check is required, and main does not deploy. The rules are in [evals.md](docs/constraints/evals.md) and [deploy-gates.md](docs/constraints/deploy-gates.md).

The eval scores the rules alone, then the rules followed by each candidate model: Claude Haiku 5.5 and Claude Sonnet 5.5. The pull request's comment shows recall and spend for each, beside the rules alone. [src/extract/model.ts](src/extract/model.ts) is the only code that calls a model. It goes through OpenRouter to Anthropic only, sends only funding text, and keeps a reference only if the text gives it as written ([model-calls.md](docs/constraints/model-calls.md)). The eval reads its key from the `OPENROUTER_KEY` secret on the `eval` environment, a key with its own credit limit. The release is still the rules alone until a run calls the model.

The eval scores two gold sets. Gold set A is 300 papers Europe PMC already links to a CRUK grant and whose full text, less its reference list and the metadata in its front matter, prints at least one of those grants. Its answers are the linked grants each paper prints, in a CRUK reference form ([#502](https://github.com/t-d-d/grantlink/issues/502), [#503](https://github.com/t-d-d/grantlink/issues/503)). Europe PMC also links papers to grants from data outside the text, which no reader can find. It sometimes lists CRUK's id in the Crossref Funder Registry as a grant, but that names the funder and is never an answer. Gold set B is the 100 papers drawn in [docs/gold-set-b-sample.json](docs/gold-set-b-sample.json), which Europe PMC links to none. Two passes of a Claude model proposed gold set B's labels against [the guide](docs/gold-set-b-guide.md), and the owner checked them ([#175](https://github.com/t-d-d/grantlink/issues/175)). The owner checked 58 of the 100 papers and accepted the other 42 when a random sample of 10, drawn with seed 20261109, found no error. The owner changed none of the labels. Because a Claude model proposed them, the labels may favour a model over the rules, so read what the model adds with that in mind. The labels are in [evals/gold-b.json](evals/gold-b.json).

The snapshot is the gold sets' funding text, under `eval/` in the private bucket. A run takes it once, after it publishes: it samples gold set A with the query and seed in [evals/gold-a.json](evals/gold-a.json), takes gold set B's papers from its labels, reads each paper into `cache/` and `eval/<id>/papers/`, so each snapshot cuts its own text, and writes a manifest of each paper and its text's hash. The run logs the manifest's hash as `snapshot-written`. To pin it, download the manifest and run the pin:

```sh
id=$(jq -r .id evals/snapshot.json)
bucket="grantlink-text-$(AWS_PROFILE=grantlink-eval aws sts get-caller-identity --query Account --output text)"
mkdir -p ".eval/eval/$id"
AWS_PROFILE=grantlink-eval aws s3api get-object --bucket "$bucket" --key "eval/$id/manifest.json" ".eval/eval/$id/manifest.json"
node evals/pin.ts .eval
```

and raise the change to `evals/` as a pull request. Until a snapshot is pinned, the rows that need it show what they wait for and do not block.

A session runs the eval itself while it iterates, with `AWS_PROFILE=grantlink-eval OPENROUTER_KEY=proxy NODE_USE_ENV_PROXY=1 npm run eval`. The key is a network secret for `openrouter.ai`, which the proxy puts into each request, so the session never sees it and any value will do. `NODE_USE_ENV_PROXY=1` sends Node's own requests through that proxy. It reads the snapshot through `access-eval`, which may read `eval/` and nothing else. Its runs are advice and never enter the cache. The snapshot lands in `.eval/`, which git and Prettier leave out, since it holds funding text and names.

## How a run works

A run is one Lambda Durable Function execution, in [src/run/](src/run/). It searches Europe PMC for open-access papers published since 1 January 2020 whose funding or acknowledgement text names Cancer Research UK, that Europe PMC links to none of its grants, and that Europe PMC does not mark as retracted or as a correction notice. It reads each paper not yet read, about 2 requests a second, and keeps only the paper's funding statements, the funding sources and award ids from its funding metadata, and its acknowledgements and funding sections, notes and footnotes, in the private bucket. A section counts as funding by its type or its title. A note or footnote counts the same way, or, with neither, when it names the funder, though a footnote only in a footnote group. Rules find the grant references, and the table records each one as written and normalised, with the versions that found it. The run then builds the page from the table and publishes it, with the data behind it as `found.json`. The page lists and counts the papers the latest complete search returned, and any that a run which started after it has returned so far, even if that run's search has not ended. When a run's search ends, the run records its id as the latest complete search, unless a run that started later has recorded its own. Each paper keeps the mark of the latest-started run whose search returned it. So when two runs overlap, the page lists every paper the newer search returned, whichever run publishes last (#125). A paper Europe PMC has since linked to a grant, or marked as retracted, drops out of the search, so it leaves the page, though the table keeps its row. A correction notice repeats the funding text of the paper it corrects, so the page also leaves out any paper whose title marks it as one, and the deploy takes one an older run published off the page (#660). The run writes the page only if `release.json` beside it names the run's own release, because the page it builds shows that release and only the deploy writes the record. Otherwise it publishes only `found.json` and leaves the page alone. That way a run that started before a deploy does not bring the old template back (#73), and a run whose deploy failed to publish does not show a release the record does not name (#119). Its findings reach the page at the next deploy or run. A paper that fails waits for the next run. A run that fails, or whose search finds nothing, publishes nothing, and the page keeps what it had. The one exception is a run that fails while it publishes. It writes `found.json` before the page, so a run whose page write fails on every try can leave its `found.json` on the site, where anyone can read it straight away. The page served does not change, so for a while `found.json` holds newer data than the page. The next deploy builds the page from that `found.json`, and the page then shows the failed run's findings and its date. The next run that publishes shows those findings too, because the table already holds them. That is acceptable because the run had finished reading and its data is complete. A run publishes only if some paper the latest complete search returned has been read, by that run or an earlier one. So a run that reads none of the papers it finds, because each was read before or failed, still publishes when one of them was read before, and the page then carries that run's date.

## Licence

The code is under the Apache License 2.0. The licence covers the code only. Paper titles and funding text belong to their publishers, under each paper's own licence.
