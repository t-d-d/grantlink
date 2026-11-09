#!/usr/bin/env bash
# Checks the app stack before the deploy runs sls deploy (#89), and stops
# the deploy, naming the resource and what the owner does next, when
# CloudFormation would refuse the update anyway:
#
# - the stack is stuck in a cleanup or rollback state, or in any state but
#   a settled one; or
# - the funding text bucket exists but the stack does not list it, as a
#   retained bucket would after a failed create.
#
# The deploy workflow runs it once the deploy role is assumed;
# test/check-stack.int.ts runs it against a stub aws.
#
# The bucket's name and AWS's error messages carry the account id, and the
# deploy's log is public. The script never prints the name, and scrubs any
# twelve-digit number from what AWS says before it prints that.
set -euo pipefail

stack=grantlink-prod
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Prints what AWS wrote to stderr, without the account id, and stops.
fail_with() {
  sed -E 's/[0-9]{12}/<account>/g' "$1" >&2
  exit 1
}

account="$(aws sts get-caller-identity --query Account --output text)"
bucket="grantlink-text-$account"

# The stack's status, or nothing if the stack does not exist. Any other
# error stops the deploy.
if status="$(aws cloudformation describe-stacks --stack-name "$stack" \
  --query "Stacks[0].StackStatus" --output text 2>"$work/err")"; then
  :
elif grep -q "does not exist" "$work/err"; then
  status=
else
  fail_with "$work/err"
fi

case "$status" in
  "" | CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE | \
    IMPORT_COMPLETE | IMPORT_ROLLBACK_COMPLETE) ;;
  *)
    # The newest resource that failed, from the latest page of events. Only
    # its logical id and status are printed: a reason can name the bucket.
    failed="$(aws cloudformation describe-stack-events --stack-name "$stack" \
      --no-paginate --output text \
      --query "StackEvents[?ends_with(ResourceStatus, '_FAILED') && ResourceType!='AWS::CloudFormation::Stack'] | [0].[LogicalResourceId, ResourceStatus]" \
      2>"$work/err")" || fail_with "$work/err"
    if [ "$failed" = "None" ] || [ -z "$failed" ]; then
      resource="$stack"
      named="No resource in it has failed."
    else
      resource="${failed%%$'\t'*}"
      named="The last resource to fail was $resource (${failed#*$'\t'})."
    fi
    case "$status" in
      UPDATE_ROLLBACK_FAILED)
        next="In the CloudFormation console, continue the rollback, skipping $resource if it cannot roll back, then run this deploy again." ;;
      ROLLBACK_COMPLETE | ROLLBACK_FAILED | CREATE_FAILED)
        next="The stack's first create failed. Delete the stack in the CloudFormation console, then run this deploy again. ResultsTable and TextBucket are retained; if TextBucket is left behind, this check will say so." ;;
      *_IN_PROGRESS)
        next="Wait until CloudFormation settles the stack, then run this deploy again. If it keeps failing on $resource, read the stack's events in the CloudFormation console. Do not empty TextBucket or ResultsTable to let it through: they hold the data." ;;
      *)
        next="Read the stack's events for $resource in the CloudFormation console and settle the stack, then run this deploy again." ;;
    esac
    echo "::error::$stack is in $status, so CloudFormation will not update it. $named $next"
    exit 1
    ;;
esac

# Whether the stack lists the funding text bucket.
listed=0
if [ -n "$status" ]; then
  listed="$(aws cloudformation list-stack-resources --stack-name "$stack" \
    --query "length(StackResourceSummaries[?LogicalResourceId=='TextBucket'])" \
    --output text 2>"$work/err")" || fail_with "$work/err"
fi
if [ "$listed" != "0" ]; then
  exit 0
fi

# The deploy role may not touch the bucket, so S3 answers 403 when it exists
# and 404 when it does not.
if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>"$work/err"; then
  :
elif grep -qE "\(403\)|Forbidden" "$work/err"; then
  :
elif grep -qE "\(404\)|Not Found" "$work/err"; then
  exit 0
else
  fail_with "$work/err"
fi

echo "::error::TextBucket, the funding text bucket, exists but $stack does not list it, so CloudFormation would refuse to create it. It holds the funding text: do not delete it. Import it into $stack under the logical id TextBucket (CloudFormation console, Import resources into stack), then run this deploy again."
exit 1
