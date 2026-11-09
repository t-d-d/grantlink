#!/usr/bin/env bash
# Publishes the page to its bucket at the end of a deploy, then clears
# CloudFront's copy. The deploy workflow runs it with BUCKET and
# DISTRIBUTION set; test/publish-page.int.ts runs it against a stub aws.
#
# A run publishes the page with its findings, and found.json, the data it
# built them from. Build the page again from that data and the release
# record, so a new template keeps the findings and the page shows this
# release, and leave found.json alone. Only a missing found.json,
# before the first run, skips this: any other error stops the deploy before
# it overwrites the findings.
#
# A run can publish while this script runs (#46). The script reads
# index.html's ETag before it reads found.json, and uploads index.html only
# if the ETag has not changed since. If a run has published in between, S3
# refuses the upload, and the script reads found.json again and builds the
# page again: the run's findings stay, shown with this deploy's template.
#
# The eval reads which release is live from release.json (#85), so the
# record goes up only once S3 has accepted the page that shows it, and
# with no-cache, so nobody reads a record older than the page (#119).
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

# Builds index.html from the template, the release record the deploy
# wrote, and the last run's data, and keeps in $page the ETag of the page
# it read first. Only a missing found.json, before the first run, builds the
# page with no findings.
build_index() {
  cp "$repo/site/index.html" "$work/site/index.html"
  rm -f "$work/found.json"
  page="$(etag index.html)"
  data="$(etag found.json)"
  if [ -n "$data" ]; then
    aws s3 cp "s3://$BUCKET/found.json" "$work/found.json" --only-show-errors
  fi
  node "$repo/src/page/build.ts" "$work/site/index.html" \
    "$repo/site/release.json" "$work/found.json"
}

# Uploads index.html only if the page in the bucket is still the one
# build_index read. Sets $refused when S3 refuses it for that reason:
# PreconditionFailed when the page changed, NoSuchKey when it went, and
# ConditionalRequestConflict when another write to it is under way.
put_index() {
  local unchanged
  if [ -n "$page" ]; then
    unchanged=(--if-match "$page")
  else
    unchanged=(--if-none-match "*")
  fi
  refused=
  if aws s3api put-object --bucket "$BUCKET" --key index.html \
    --body "$work/site/index.html" \
    --content-type "text/html; charset=utf-8" \
    --cache-control "public, max-age=300" \
    "${unchanged[@]}" >/dev/null 2>"$work/put.err"; then
    return
  fi
  if grep -qE "PreconditionFailed|NoSuchKey|ConditionalRequestConflict" "$work/put.err"; then
    refused=1
    return
  fi
  cat "$work/put.err" >&2
  exit 1
}

build_index
aws s3 sync "$work/site/" "s3://$BUCKET/" --delete \
  --exclude found.json --exclude index.html --exclude release.json \
  --cache-control "public, max-age=300" --only-show-errors
for try in 1 2 3; do
  put_index
  if [ -z "$refused" ]; then
    break
  fi
  echo "::notice::The page changed while the deploy built it (try $try of 3)."
  # Not under && or ||, which would turn off set -e inside the function.
  if [ "$try" -lt 3 ]; then
    build_index
  fi
done
if [ -n "$refused" ]; then
  cat "$work/put.err" >&2
  echo "The page kept changing while the deploy built it." >&2
  exit 1
fi
if [ -e "$repo/site/release.json" ]; then
  aws s3api put-object --bucket "$BUCKET" --key release.json \
    --body "$repo/site/release.json" \
    --content-type "application/json" \
    --cache-control "no-cache" >/dev/null
fi

id="$(aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" \
  --paths "/*" --query Invalidation.Id --output text)"
aws cloudfront wait invalidation-completed --distribution-id "$DISTRIBUTION" --id "$id"
