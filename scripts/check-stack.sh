#!/usr/bin/env bash
# Checks the app stack before the deploy runs sls deploy (#89), and stops
# the deploy, naming the resource and what the owner does next, when
# CloudFormation would refuse the update anyway:
#
# - the stack is stuck in a cleanup or rollback state, or in any state but
#   a settled one; or
# - the funding text bucket exists but the stack does not list it. With a
#   stack, the owner imports it. With none, as after a failed first create
#   or a deleted stack, the owner copies out what it holds, empties and
#   deletes it, and copies it back after the deploy (#129, #197). The
#   results table is retained too and has no fixed name, so after a deleted
#   stack the owner copies its rows to the new table before the first run
#   (#254).
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
    # The latest page of events, newest first: each one's logical id, its
    # status, and whether it is the stack's own "User Initiated" event, which
    # starts an operation. Only ids and statuses are printed: a reason can
    # name the bucket.
    aws cloudformation describe-stack-events --stack-name "$stack" \
      --no-paginate --output text \
      --query "StackEvents[].[LogicalResourceId, ResourceStatus, LogicalResourceId=='$stack' && ResourceStatusReason=='User Initiated']" \
      >"$work/events" 2>"$work/err" || fail_with "$work/err"
    # The newest resource that failed in the current operation. Events from
    # before the operation started belong to an older one (#129).
    failed=
    while IFS=$'\t' read -r id event started; do
      if [ "$id" != "$stack" ] && [[ "$event" == *_FAILED ]]; then
        failed="$id"$'\t'"$event"
        break
      fi
      if [ "$started" = "True" ]; then
        break
      fi
    done <"$work/events"
    if [ -z "$failed" ]; then
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
      REVIEW_IN_PROGRESS)
        next="The stack holds a change set that never ran, and CloudFormation does not settle that by itself. Delete the stack in the CloudFormation console, then run this deploy again." ;;
      *_IN_PROGRESS)
        next="Wait until CloudFormation settles the stack, then run this deploy again. If it keeps failing on $resource, read the stack's events in the CloudFormation console. Do not empty TextBucket or ResultsTable to let it through: they hold the data." ;;
      *)
        next="Read the stack's events for $resource in the CloudFormation console and settle the stack, then run this deploy again." ;;
    esac
    echo "::error::$stack is in $status, so CloudFormation will not update it. $named $next"
    exit 1
    ;;
esac

# Whether the stack lists the funding text bucket. JSON, because with text
# output the CLI runs the query once on each page of resources.
listed=0
if [ -n "$status" ]; then
  listed="$(aws cloudformation list-stack-resources --stack-name "$stack" \
    --query "length(StackResourceSummaries[?LogicalResourceId=='TextBucket'])" \
    --output json 2>"$work/err")" || fail_with "$work/err"
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

if [ -z "$status" ]; then
  # Creating the stack around the bucket by import is untested with osls,
  # so the owner chose (#129) to empty and delete it. The check cannot tell
  # a failed first create from a deleted stack, after which the retained
  # bucket still holds the data, so the advice keeps every prefix (#197).
  echo "::error::TextBucket, the funding text bucket, exists but $stack does not, as after a failed first create or a deleted stack, so CloudFormation would refuse to create it. TextBucket is retained, so after a deleted stack it still holds the data. If it holds anything under cache/ (each paper's funding text), eval/ (the eval snapshot) or eval-reports/ (the reports CI filed), copy it out first, to a private bucket in eu-west-2: the cache lets a run re-read papers under new rules without fetching them again, the repo pins the snapshot's hash, and the eval reuses its reports. Then empty and delete the funding text bucket in the S3 console, run this deploy again, and once it has made the bucket, copy back what you kept. ResultsTable, the results table, is retained too, so after a deleted stack it is left behind under its old name, grantlink-prod-ResultsTable- and a suffix, and the deploy makes a new, empty one, named in $stack's ResultsTableName output. The deploy that makes the stack starts the first run a quarter of an hour after that deploy starts, and making the stack takes part of that time. A run fetches every paper it has no row for, so on an empty table it fetches every paper again. So as soon as the stack exists, and before the first run starts, copy every item from the old table to the new one, for example with aws dynamodb scan on the old table and aws dynamodb batch-write-item, 25 items at a time, on the new one. A failed first create leaves an empty table behind too, so if more than one is left behind, copy from the one that holds items. If none holds items, there is nothing to copy."
  exit 1
fi
echo "::error::TextBucket, the funding text bucket, exists but $stack does not list it, so CloudFormation would refuse to create it. It holds the funding text: do not delete it. Import it into $stack under the logical id TextBucket (CloudFormation console, Import resources into stack), then run this deploy again."
exit 1
