#!/usr/bin/env bash
# Applies the two stacks the owner applies by hand, once, and gives GitHub
# every value the deploy and the eval read. Run it from the repo root on your
# own machine, with:
#
#   - AWS credentials for the organization's management account, as an
#     administrator, in the environment or a profile named by AWS_PROFILE;
#   - gh signed in, with admin rights on t-d-d/grantlink.
#
# It finds grantlink's account by its name in the organization and works
# there through OrganizationAccountAccessRole, which every account made in
# the organization has. That session lasts an hour. If the certificate is
# still waiting for the registrar by then, the script stops; run it again
# once the DNS stack has finished.
#
# It asks one question, whether the account is the right one, and types
# nothing else. Run it again at any time: each step changes only what
# differs.
set -euo pipefail

REPO=t-d-d/grantlink
REGION=us-east-1
DOMAIN=grantlink.uk
DNS_STACK=grantlink-dns
ROLES_STACK=grantlink-github-oidc

management=$(aws sts get-caller-identity --query Account --output text)
account=$(aws organizations list-accounts --query "Accounts[?Name=='grantlink'].Id" --output text)
case $account in
  "" | None | *[!0-9]*)
    echo "Found no single account named grantlink in this organization. Nothing was changed."
    exit 1
    ;;
esac
read -r -p "Apply grantlink's stacks to account ${account}, from management account ${management}? [y/N] " answer
[ "$answer" = "y" ] || { echo "Stopped. Nothing was changed."; exit 1; }

# From here on, every command acts in grantlink's account.
credentials=$(aws sts assume-role \
  --role-arn "arn:aws:iam::${account}:role/OrganizationAccountAccessRole" \
  --role-session-name grantlink-bootstrap \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN <<<"$credentials"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
export AWS_DEFAULT_REGION="$REGION"
unset AWS_PROFILE

output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

# 1. The DNS stack. CloudFormation waits for ACM to validate the
# certificate, which needs the registrar to point at the new zone, so the
# zone's nameservers are printed as soon as it exists.
aws cloudformation deploy --region "$REGION" --no-fail-on-empty-changeset \
  --stack-name "$DNS_STACK" --template-file infra/dns.cfn.yml &
dns=$!
zone=None
while [ "$zone" = "None" ] && kill -0 "$dns" 2>/dev/null; do
  sleep 10
  zone=$(aws route53 list-hosted-zones-by-name --dns-name "$DOMAIN." \
    --query "HostedZones[?Name=='$DOMAIN.'] | [0].Id" --output text)
done
if [ "$zone" != "None" ]; then
  echo
  echo "Set these as the nameservers for $DOMAIN at the registrar now."
  echo "The certificate, and so the DNS stack, waits until they take effect."
  aws route53 get-hosted-zone --id "$zone" \
    --query 'DelegationSet.NameServers' --output text | tr '\t' '\n'
  echo
fi
wait "$dns"

# 2. The roles stack. It reads the access account's id from SSM, and builds
# the private bucket's name from this account, so it takes no parameters.
aws cloudformation deploy --region "$REGION" --no-fail-on-empty-changeset \
  --stack-name "$ROLES_STACK" --template-file infra/github-oidc.cfn.yml \
  --capabilities CAPABILITY_NAMED_IAM

# 3. What GitHub reads. ARNs and the bucket's name carry the account id, so
# they are secrets. The values go to gh on its standard input, never on a
# command line.
bucket="grantlink-text-${account}"
output "$ROLES_STACK" DeployRoleArn | gh secret set AWS_DEPLOY_ROLE_ARN --repo "$REPO" --env prod
output "$ROLES_STACK" DeployExecutionRoleArn | gh secret set AWS_DEPLOY_EXECUTION_ROLE_ARN --repo "$REPO" --env prod
output "$DNS_STACK" CertificateArn | gh secret set CERTIFICATE_ARN --repo "$REPO" --env prod
output "$DNS_STACK" HostedZoneId | gh variable set HOSTED_ZONE_ID --repo "$REPO" --env prod
echo -n "$bucket" | gh secret set PRIVATE_BUCKET_NAME --repo "$REPO" --env prod
echo -n "$bucket" | gh secret set PRIVATE_BUCKET_NAME --repo "$REPO" --env eval
output "$ROLES_STACK" CiEvalRoleArn | gh secret set AWS_EVAL_ROLE_ARN --repo "$REPO" --env eval

echo "Done. Both stacks are applied, and GitHub has every value it reads."
