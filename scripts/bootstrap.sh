#!/usr/bin/env bash
# Applies the two stacks the owner applies by hand, and gives GitHub the
# role each job assumes: the deploy's in prod and the eval's in eval. A job
# finds or builds every other value once it has assumed its role (#43). Run it from the repo root on your own
# machine, with:
#
#   - AWS credentials for grantlink's account, as an administrator, however
#     you come by them;
#   - gh signed in, with admin rights on t-d-d/grantlink.
#
# It asks one question, whether the account is the right one, and types
# nothing else.
#
# Run it again at any time. Each step changes only what differs, and it
# waits for a stack an earlier run left part way. If the credentials expire
# while the certificate waits for the registrar, the script stops but the
# stack carries on, and the next run waits for it. A stack whose first
# create failed has to be deleted before a run can apply it, and the script
# says so.
set -euo pipefail

REPO=t-d-d/grantlink
REGION=us-east-1
DOMAIN=grantlink.uk
DNS_STACK=dns
ROLES_STACK=grantlink-github-oidc

account=$(aws sts get-caller-identity --query Account --output text)
read -r -p "Apply grantlink's stacks to account ${account}? [y/N] " answer
[ "$answer" = "y" ] || { echo "Stopped. Nothing was changed."; exit 1; }

# The roles stack reads the access account's id from this parameter, which
# aws-access's access-reader StackSet puts in every member account.
aws ssm get-parameter --region "$REGION" --name /access/account-id >/dev/null || {
  echo "grantlink's account has no /access/account-id parameter in $REGION."
  echo "Add the account to aws-access's access-reader StackSet first. Nothing was changed."
  exit 1
}

output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

# Waits for a stack an earlier run left part way, so the deploy after it
# finds the stack settled. CloudFormation cannot update a stack whose first
# create failed, so that one stops the script.
settle() {
  local status
  status=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null) || return 0
  case $status in
    CREATE_IN_PROGRESS)
      echo "Waiting for $1, which an earlier run left being created."
      aws cloudformation wait stack-create-complete --region "$REGION" --stack-name "$1"
      ;;
    UPDATE_IN_PROGRESS | UPDATE_COMPLETE_CLEANUP_IN_PROGRESS)
      echo "Waiting for $1, which an earlier run left being updated."
      aws cloudformation wait stack-update-complete --region "$REGION" --stack-name "$1"
      ;;
    UPDATE_ROLLBACK_IN_PROGRESS | UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS)
      echo "Waiting for $1, which is rolling back an update."
      aws cloudformation wait stack-rollback-complete --region "$REGION" --stack-name "$1"
      ;;
    DELETE_IN_PROGRESS)
      echo "Waiting for $1, which is being deleted."
      aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$1"
      ;;
    UPDATE_ROLLBACK_FAILED)
      echo "$1 failed to roll back an update. Continue its rollback in the console, then run this again."
      exit 1
      ;;
    ROLLBACK_IN_PROGRESS | ROLLBACK_COMPLETE | ROLLBACK_FAILED)
      echo "$1 failed when it was first created, so CloudFormation cannot update it."
      echo "Delete it once its rollback has finished, then run this again."
      exit 1
      ;;
  esac
}

# The zone the DNS stack made, or None until it exists. It is read from the
# stack, not looked up by name, since a zone kept from an earlier stack has
# the same name.
stack_zone() {
  local id
  id=$(aws cloudformation describe-stack-resource --region "$REGION" --stack-name "$DNS_STACK" \
    --logical-resource-id HostedZone \
    --query StackResourceDetail.PhysicalResourceId --output text 2>/dev/null) || id=None
  echo "${id:-None}"
}

# Prints a zone's nameservers for the owner to set at the registrar.
nameservers() {
  echo
  echo "The nameservers for $DOMAIN. If the registrar does not list them yet, set them there now."
  echo "The certificate, and so the DNS stack, waits until the registrar points at them."
  aws route53 get-hosted-zone --id "$1" --query 'DelegationSet.NameServers' --output text | tr '\t' '\n'
  echo
}

# 1. The DNS stack. CloudFormation waits for ACM to validate the
# certificate, which needs the registrar to point at the zone, so the zone's
# nameservers are printed as soon as it exists: before the wait for a stack
# an earlier run left being created, or else while the deploy runs.
zone=$(stack_zone)
[ "$zone" = "None" ] || nameservers "$zone"
settle "$DNS_STACK"
aws cloudformation deploy --region "$REGION" --no-fail-on-empty-changeset \
  --stack-name "$DNS_STACK" --template-file infra/dns.cfn.yml &
dns=$!
while [ "$zone" = "None" ] && kill -0 "$dns" 2>/dev/null; do
  sleep 10
  zone=$(stack_zone)
  [ "$zone" = "None" ] || nameservers "$zone"
done
wait "$dns"

# 2. The roles stack. It reads the access account's id from SSM, and builds
# the private bucket's name from this account, so it takes no parameter a
# person fills.
settle "$ROLES_STACK"
aws cloudformation deploy --region "$REGION" --no-fail-on-empty-changeset \
  --stack-name "$ROLES_STACK" --template-file infra/github-oidc.cfn.yml \
  --capabilities CAPABILITY_NAMED_IAM

# 3. What GitHub reads. Every value is read and checked before GitHub is
# given any, so a session that runs out here, or an output that is
# missing, stops the script before GitHub changes.
deploy_role=$(output "$ROLES_STACK" DeployRoleArn)
eval_role=$(output "$ROLES_STACK" CiEvalRoleArn)
for name in deploy_role eval_role; do
  case ${!name} in
    "" | None) echo "The stacks gave no value for $name, so GitHub was not changed."; exit 1 ;;
  esac
done

# Gives GitHub one value. ARNs carry the account id, so they are secrets,
# and each value goes to gh on its standard input, never on a command line.
give() {
  printf '%s' "$4" | gh "$1" set "$2" --repo "$REPO" --env "$3"
}

# Removes a value earlier runs gave GitHub and the jobs no longer read. One
# that is already gone counts as removed, so the script can run again.
drop() {
  local err
  if ! err=$(gh "$1" delete "$2" --repo "$REPO" --env "$3" 2>&1 >/dev/null); then
    case $err in
      *"HTTP 404"*) ;;
      *) echo "$err" >&2; exit 1 ;;
    esac
  fi
}

give secret AWS_DEPLOY_ROLE_ARN prod "$deploy_role"
give secret AWS_EVAL_ROLE_ARN eval "$eval_role"

drop secret AWS_DEPLOY_EXECUTION_ROLE_ARN prod
drop secret CERTIFICATE_ARN prod
drop variable HOSTED_ZONE_ID prod
drop secret PRIVATE_BUCKET_NAME prod
drop secret PRIVATE_BUCKET_NAME eval

echo "Done. Both stacks are applied, and GitHub holds the role each job assumes."
