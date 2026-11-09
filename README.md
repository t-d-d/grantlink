# grantlink

grantlink finds research papers that say Cancer Research UK funded them but that Europe PMC links to no CRUK grant. It reads the grant reference from each paper's funding text, publishes the links, and publishes how the service is run: the go/no-go criteria set before the build, the evals that gate every release, and the check behind every limit it works within.

It is an independent demonstration on public data from [Europe PMC](https://europepmc.org/). It is not affiliated with or endorsed by Cancer Research UK.

The plan is the PRD, [#1](https://github.com/t-d-d/grantlink/issues/1). The decisions behind it are the issues labelled `type: adr`, and the rules in force are in [docs/constraints/](docs/constraints/README.md).

## Setting up the AWS account

Two stacks are applied by hand, once, before anything deploys. Both go in grantlink's own account, in us-east-1, and both are code in [infra/](infra/). Every later change to the account goes through the app stack, from a green merge to main.

Apply them in this order.

1. **The DNS stack**, [infra/dns.cfn.yml](infra/dns.cfn.yml): the hosted zone for grantlink.uk and its certificate.

   ```sh
   aws cloudformation deploy --region us-east-1 \
     --stack-name grantlink-dns --template-file infra/dns.cfn.yml
   ```

   The stack waits until ACM has validated the certificate, which needs the registrar to point at the new zone. While it waits, read the zone's nameservers in the Route 53 console, or with `aws route53 get-hosted-zone`, and set them at the registrar. The stack outputs them too, once it finishes. The zone is kept if the stack is deleted, so the nameservers never change under the registrar.

2. **The roles stack**, [infra/github-oidc.cfn.yml](infra/github-oidc.cfn.yml): GitHub's OIDC provider, the deploy role and the role CloudFormation takes to build the app stack, the CI eval role, and `access-eval` for aws-access's `grantlink-eval` profile. It needs the SSM parameter `/access/account-id` in us-east-1 to hold the access account's id, and the private bucket's name, which the app stack uses too.

   ```sh
   aws cloudformation deploy --region us-east-1 \
     --stack-name grantlink-github-oidc --template-file infra/github-oidc.cfn.yml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides PrivateBucketName=<the private bucket's name>
   ```

Then give GitHub what the deploy and the eval read. Role ARNs and the certificate's ARN carry the account id, so they are secrets, never variables.

| Name | Kind | GitHub environment | Value |
| --- | --- | --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | Secret | `prod` | The roles stack's `DeployRoleArn` output |
| `AWS_DEPLOY_EXECUTION_ROLE_ARN` | Secret | `prod` | The roles stack's `DeployExecutionRoleArn` output |
| `CERTIFICATE_ARN` | Secret | `prod` | The DNS stack's `CertificateArn` output |
| `HOSTED_ZONE_ID` | Variable | `prod` | The DNS stack's `HostedZoneId` output |
| `PRIVATE_BUCKET_NAME` | Variable | `prod` and `eval` | The name given to the roles stack |
| `AWS_EVAL_ROLE_ARN` | Secret | `eval` | The roles stack's `CiEvalRoleArn` output |

The `AccessEvalRoleArn` output goes to aws-access, for the `grantlink-eval` profile.

The deploy role trusts only the `prod` environment and the CI eval role only the `eval` environment, so a workflow job must name its environment to reach either. The gate checks both templates with [cfn-lint](https://github.com/aws-cloudformation/cfn-lint), so running the gate locally needs it installed (`pipx install cfn-lint`).

## Licence

The code is under the Apache License 2.0. The licence covers the code only. Paper titles and funding text belong to their publishers, under each paper's own licence.
