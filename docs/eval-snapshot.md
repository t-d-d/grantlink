# The eval snapshot

The snapshot is the gold sets' funding text, under `eval/` in the private bucket. A run writes the snapshot that [evals/snapshot.json](../evals/snapshot.json) names when it does not exist yet. It samples gold sets A and A2 with their queries and seeds, takes gold set B's papers from its labels, and writes a manifest of each paper and its text's hash. The run logs the manifest's hash as `snapshot-written`.

## Pinning it

Download the manifest and run the pin:

```sh
id=$(jq -r .id evals/snapshot.json)
bucket="grantlink-text-$(AWS_PROFILE=grantlink-eval aws sts get-caller-identity --query Account --output text)"
mkdir -p ".eval/eval/$id"
AWS_PROFILE=grantlink-eval aws s3api get-object --bucket "$bucket" --key "eval/$id/manifest.json" ".eval/eval/$id/manifest.json"
node evals/pin.ts .eval
```

Then raise the change to `evals/` as a pull request. Until a snapshot is pinned, the rows that need it wait and block nothing.

## Running the eval in a session

```sh
AWS_PROFILE=grantlink-eval OPENROUTER_KEY=proxy NODE_USE_ENV_PROXY=1 npm run eval
```

`OPENROUTER_KEY` is a network secret for `openrouter.ai`. The session's proxy adds the real key to each request, so the session never sees it and any value will do. `NODE_USE_ENV_PROXY=1` sends Node's own requests through that proxy. The `grantlink-eval` profile reads `eval/` and nothing else.

The snapshot lands in `.eval/`, which git and Prettier leave out, because it holds funding text and names. A session's runs are advice. Only CI files the reports that gate a release.
