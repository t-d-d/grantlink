#!/usr/bin/env bash
# Downloads the eval snapshot named in evals/snapshot.json into a directory,
# laid out as the bucket is, and checks its manifest against the pin. The
# runner then reads it from disk (docs/constraints/evals.md).
#
#   scripts/eval-snapshot.sh <dir>
#
# The bucket is grantlink-text-<account> for the account the AWS
# credentials are in, as the app stack names it. A session runs it with AWS_PROFILE=grantlink-eval, which may read eval/ and
# nothing else, so it reads only the keys the manifest names.
#
# The files hold funding text and names. Keep them in the directory given,
# which .gitignore leaves out, and never print them.
set -euo pipefail

dir="${1:?usage: scripts/eval-snapshot.sh <dir>}"
id="$(jq -r .id evals/snapshot.json)"
pin="$(jq -r .manifestSha256 evals/snapshot.json)"
mkdir -p "$dir/eval/$id" "$dir/eval/papers"

if [ "$pin" = "null" ]; then
  echo "No snapshot is pinned yet, so there is nothing to download."
  exit 0
fi

bucket="grantlink-text-$(aws sts get-caller-identity --query Account --output text)"

manifest="$dir/eval/$id/manifest.json"
aws s3api get-object --bucket "$bucket" --key "eval/$id/manifest.json" "$manifest" >/dev/null
got="$(sha256sum "$manifest" | cut -d' ' -f1)"
if [ "$got" != "$pin" ]; then
  echo "The manifest of snapshot $id does not match its pin in evals/snapshot.json." >&2
  exit 1
fi

jq -r '.papers[].pmcid' "$manifest" | while read -r pmcid; do
  aws s3api get-object --bucket "$bucket" --key "eval/papers/$pmcid.json" \
    "$dir/eval/papers/$pmcid.json" >/dev/null
done
echo "Downloaded snapshot $id: $(jq '.papers | length' "$manifest") papers."
