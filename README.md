# grantlink

grantlink finds research papers that say Cancer Research UK funded them but that Europe PMC links to no CRUK grant. It reads the grant reference from each paper's funding text, publishes the links, and publishes how the service is run: the go/no-go criteria set before the build, the evals that gate every release, and the check behind every limit it works within.

It is an independent demonstration on public data from [Europe PMC](https://europepmc.org/). It is not affiliated with or endorsed by Cancer Research UK.

The data comes from Europe PMC, through its public web services, under the [EMBL-EBI terms of use](https://www.ebi.ac.uk/about/terms-of-use/). For corrections or removals, write to thomas.david.dickinson@gmail.com.

The plan is the PRD, [#1](https://github.com/t-d-d/grantlink/issues/1). The decisions behind it are the issues labelled `type: adr`, and the rules in force are in [docs/constraints/](docs/constraints/README.md).

## Setting up the AWS account

Two stacks are applied by hand, once, before anything deploys, and both are code in [infra/](infra/):

- **The DNS stack**, `dns`, from [infra/dns.cfn.yml](infra/dns.cfn.yml): the hosted zone for grantlink.uk and its certificate, in us-east-1, where CloudFront requires the certificate. The zone is kept if the stack is deleted, so its nameservers never change under the registrar.
- **The roles stack**, `grantlink-github-oidc`, from [infra/github-oidc.cfn.yml](infra/github-oidc.cfn.yml): GitHub's OIDC provider, the deploy role and the role CloudFormation takes to build the app stack, the CI eval role, and `access-eval` for aws-access's `grantlink-eval` profile. IAM is global, so it sits in us-east-1 beside the DNS stack. It reads the access account's id from aws-access's `/access/account-id` parameter in us-east-1.

Every later change to the account goes through the app stack, from a green merge to main.

Run one script, from the repo root on your own machine, with AWS credentials for grantlink's account as an administrator, however you come by them, and `gh` signed in with admin rights on this repo. Before it changes anything, the script checks that the account holds aws-access's `/access/account-id` parameter, which the roles stack reads. The account must not already have a GitHub OIDC provider of its own, or the roles stack fails:

```sh
scripts/bootstrap.sh
```

It asks only whether the account is the right one. Then it:

1. Applies the DNS stack, and prints the zone's nameservers as soon as the zone exists. If the registrar does not list them yet, set them there then: the certificate, and so the stack, waits until it does.
2. Applies the roles stack. It takes no parameter a person fills. It reads the access account's id from SSM, and the private bucket is `grantlink-text-<account id>`, the name the app stack (#19) must give it.
3. Gives GitHub every value the deploy and the eval read:

| Name | Kind | GitHub environment | Value |
| --- | --- | --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | Secret | `prod` | The roles stack's `DeployRoleArn` output |
| `AWS_DEPLOY_EXECUTION_ROLE_ARN` | Secret | `prod` | The roles stack's `DeployExecutionRoleArn` output |
| `CERTIFICATE_ARN` | Secret | `prod` | The DNS stack's `CertificateArn` output |
| `HOSTED_ZONE_ID` | Variable | `prod` | The DNS stack's `HostedZoneId` output |
| `PRIVATE_BUCKET_NAME` | Secret | `prod` and `eval` | `grantlink-text-<account id>` |
| `AWS_EVAL_ROLE_ARN` | Secret | `eval` | The roles stack's `CiEvalRoleArn` output |

Role ARNs, the certificate's ARN and the bucket's name carry the account id, so they are secrets, never variables. The script reads every value before it gives GitHub any, and stops rather than give an empty one.

The script is safe to run again. Each step changes only what differs, and it waits for a stack an earlier run left part way. If the credentials expire while the certificate waits for the registrar, the script stops while the stack carries on. Run it again and it waits for the stack. A stack whose first create failed has to be deleted before a run can apply it, and the script says so.

The deploy role trusts only the `prod` environment and the CI eval role only the `eval` environment, so a workflow job must name its environment to reach either. The gate checks both templates with [cfn-lint](https://github.com/aws-cloudformation/cfn-lint), so running the gate locally needs the version CI pins in [gate.yml](.github/workflows/gate.yml) (`pipx install cfn-lint==1.60.0`).

## How it deploys

The app stack, `grantlink-prod`, is defined in [serverless.yml](serverless.yml) and deployed with [osls](https://github.com/oss-serverless/osls), the open-source fork of the Serverless Framework. It runs in London (eu-west-2). It holds the page, the run and the run's stores. The page is files in a private S3 bucket behind CloudFront, served over HTTPS only, with its resources in [infra/site.cfn.yml](infra/site.cfn.yml). The results table and the private bucket for funding text are in [infra/data.cfn.yml](infra/data.cfn.yml).

[deploy.yml](.github/workflows/deploy.yml) runs on every push to main, and nothing else deploys. It runs the gate, then:

1. Reads whether `AWS_DEPLOY_ROLE_ARN` and `AWS_DEPLOY_EXECUTION_ROLE_ARN` are set in `prod`. Until the bootstrap above has run, it stops there and deploys nothing.
2. Assumes the deploy role through GitHub's OIDC token, and masks the account id.
3. Deploys the app stack. The first deploy also sets a one-time schedule that starts the first run a quarter of an hour later.
4. Builds the page again from the last run's `found.json`, if there is one, copies [site/](site/) to the bucket and clears CloudFront's cache.
5. Runs the live tier against the page. A failure turns the deploy red.

CloudFront serves the page at grantlink.uk once `CERTIFICATE_ARN` and `HOSTED_ZONE_ID` are set in `prod`, and at its own `cloudfront.net` address until then. A failed deploy is fixed forward. There is no rollback step, and CloudFormation rolls a failed stack update back by itself. The eval gate joins the deploy in [#20](https://github.com/t-d-d/grantlink/issues/20).

## How a run works

A run is one Lambda Durable Function execution, in [src/run/](src/run/). It searches Europe PMC for open-access papers published since 1 January 2020 whose funding or acknowledgement text names Cancer Research UK and that Europe PMC links to none of its grants. It reads each paper not yet read, about 2 requests a second, and keeps only the paper's funding statement, acknowledgements and funding metadata, in the private bucket. Rules find the grant references, and the table records each one as written and normalised, with the versions that found it. The run then builds the page from the table and publishes it, with the data behind it as `found.json`. A paper that fails waits for the next run. A run that fails, or whose search finds nothing, publishes nothing, and the page keeps what it had. Until some run has read a paper, no run publishes. After that, a run that finds papers publishes even if it reads none of them, because each was read before or failed, and the page then carries that run's date.

## Licence

The code is under the Apache License 2.0. The licence covers the code only. Paper titles and funding text belong to their publishers, under each paper's own licence.
