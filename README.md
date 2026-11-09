# grantlink

grantlink finds research papers that say Cancer Research UK funded them but that Europe PMC links to no CRUK grant. It reads the grant reference from each paper's funding text, publishes the links, and publishes how the service is run: the go/no-go criteria set before the build, the evals that gate every release, and the check behind every limit it works within.

It is an independent demonstration on public data from [Europe PMC](https://europepmc.org/). It is not affiliated with or endorsed by Cancer Research UK.

The plan is the PRD, [#1](https://github.com/t-d-d/grantlink/issues/1). The decisions behind it are the issues labelled `type: adr`, and the rules in force are in [docs/constraints/](docs/constraints/README.md).

## Setting up the AWS account

Two stacks are applied by hand, once, before anything deploys, and both are code in [infra/](infra/):

- **The DNS stack**, [infra/dns.cfn.yml](infra/dns.cfn.yml): the hosted zone for grantlink.uk and its certificate, in us-east-1, where CloudFront requires the certificate. The zone is kept if the stack is deleted, so its nameservers never change under the registrar.
- **The roles stack**, [infra/github-oidc.cfn.yml](infra/github-oidc.cfn.yml): GitHub's OIDC provider, the deploy role and the role CloudFormation takes to build the app stack, the CI eval role, and `access-eval` for aws-access's `grantlink-eval` profile. IAM is global, so it sits in us-east-1 beside the DNS stack. It reads the access account's id from aws-access's `/access/account-id` parameter in us-east-1.

Every later change to the account goes through the app stack, from a green merge to main.

Run one script, from the repo root on your own machine, with AWS credentials for the organization's management account as an administrator, and `gh` signed in with admin rights on this repo. The script finds grantlink's account by its name and works there through `OrganizationAccountAccessRole`. Before it changes anything, it checks that the account holds aws-access's `/access/account-id` parameter. The account must not already have a GitHub OIDC provider of its own, or the roles stack fails:

```sh
scripts/bootstrap.sh
```

It asks only whether the account it found is the right one. Then it:

1. Applies the DNS stack, and prints the zone's nameservers as soon as the zone exists. Set them at the registrar then: the certificate, and so the stack, waits until they take effect.
2. Applies the roles stack. It takes no parameters: the private bucket is `grantlink-text-<account id>`, the name the app stack (#19) must give it.
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

The script is safe to run again. Each step changes only what differs, and it waits for a stack an earlier run left part way. The session in grantlink's account lasts an hour, so if the registrar is slow and the certificate is still waiting by then, the script stops while the stack carries on. Run it again and it waits for the stack. A stack whose first create failed has to be deleted before a run can apply it, and the script says so.

The deploy role trusts only the `prod` environment and the CI eval role only the `eval` environment, so a workflow job must name its environment to reach either. The gate checks both templates with [cfn-lint](https://github.com/aws-cloudformation/cfn-lint), so running the gate locally needs the version CI pins in [gate.yml](.github/workflows/gate.yml) (`pipx install cfn-lint==1.60.0`).

## Licence

The code is under the Apache License 2.0. The licence covers the code only. Paper titles and funding text belong to their publishers, under each paper's own licence.
