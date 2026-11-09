#!/usr/bin/env bash
# Publishes the page to its bucket at the end of a deploy, then clears
# CloudFront's copy. The deploy workflow runs it with BUCKET and
# DISTRIBUTION set; test/publish-page.int.ts runs it against a stub aws.
#
# A run publishes the page with its findings, and found.json, the data it
# built them from. Build the page again from that data, so a new template
# keeps the findings, and leave found.json alone. Only a missing found.json,
# before the first run, skips this: any other error stops the deploy before
# it overwrites the findings.
#
# A run can publish while this script runs (#46). The script reads
# index.html's ETag before it reads found.json, and uploads index.html only
# if the ETag has not changed since. If a run has published in between, S3
# refuses the upload and the run's page stays, built from newer data.
set -euo pipefail
: "${BUCKET:?}" "${DISTRIBUTION:?}"

repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/site"
cp -R "$repo/site/." "$work/site/"

# Prints the object's ETag, or nothing if the object does not exist. Any
# other error stops the script.
etag() {
  local out
  if out="$(aws s3api head-object --bucket "$BUCKET" --key "$1" \
    --query ETag --output text 2>"$work/head.err")"; then
    printf '%s' "$out"
  elif ! grep -qE "Not Found|404" "$work/head.err"; then
    cat "$work/head.err" >&2
    exit 1
  fi
}

page="$(etag index.html)"
data="$(etag found.json)"
if [ -n "$data" ]; then
  aws s3 cp "s3://$BUCKET/found.json" "$work/found.json" --only-show-errors
  node "$repo/src/page/build.ts" "$work/found.json" "$work/site/index.html"
fi

aws s3 sync "$work/site/" "s3://$BUCKET/" --delete \
  --exclude found.json --exclude index.html \
  --cache-control "public, max-age=300" --only-show-errors

# The page as it was when the script began, or no page at all.
if [ -n "$page" ]; then
  unchanged=(--if-match "$page")
else
  unchanged=(--if-none-match "*")
fi
if aws s3api put-object --bucket "$BUCKET" --key index.html \
  --body "$work/site/index.html" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "public, max-age=300" \
  "${unchanged[@]}" >/dev/null 2>"$work/put.err"; then
  :
elif grep -qE "PreconditionFailed|ConditionalRequestConflict" "$work/put.err"; then
  echo "::notice::A run published the page during this deploy, so the deploy kept the run's page."
else
  cat "$work/put.err" >&2
  exit 1
fi

id="$(aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" \
  --paths "/*" --query Invalidation.Id --output text)"
aws cloudfront wait invalidation-completed --distribution-id "$DISTRIBUTION" --id "$id"
