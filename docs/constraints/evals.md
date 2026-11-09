# Evals
Relevance: src/extract/**, src/shared/**, evals/**, .github/workflows/eval.yml, scripts/eval-snapshot.sh, the eval roles, the eval snapshot or the eval reports
Decision: The eval scores a fixed snapshot. Its reports are a cache keyed by a fingerprint of its inputs, written once and only by CI.

Why: Scores must compare across releases, so the text they are scored on
must not change. Every deployed commit must link to the eval that covers
it, and the same inputs should never be paid for twice. A session needs to
run the eval while it iterates, from an environment that reads public issue
text, so it must not get broad AWS access or see the key.

## Rules

- The snapshot lives under `eval/` in the private bucket. A run writes it
  once: each gold paper's funding sections at `eval/papers/<pmcid>.json`,
  and a manifest at `eval/<id>/manifest.json` listing each paper, its set,
  its text's SHA-256 and, for gold set A, Europe PMC's grant ids.
- Gold set A is sampled once, with the query, seed and size recorded in
  `evals/gold-a.json`. Once the snapshot exists, `node evals/pin.ts` pins
  the manifest's hash in `evals/snapshot.json` and copies gold set A's ids
  and grant ids into `evals/gold-a.json`. Gold set B's labels live in
  `evals/gold-b.json`. A new snapshot takes a new id.
- The repo holds paper ids, grant ids and labels only, never text.
- The fingerprint is the SHA-256 of the git hashes of `src/extract/`,
  `src/shared/`, `evals/`, `.github/workflows/eval.yml` and
  `package-lock.json`, as `evals/fingerprint.ts` computes it.
  `src/shared/` holds the one PMCID pattern, which the eval reads too.
- Code in `src/extract/`, `src/shared/` and `evals/` imports nothing from
  outside those paths except packages and Node's built-ins.
  `grantlink/imports-within` checks this.
- The runner, `evals/run.ts`, reads the snapshot from local files and
  checks the manifest against its pin and each paper against the manifest.
  The workflow downloads and files in its own steps.
- Reports live at `eval-reports/<fingerprint>.json`. A run looks there
  first and reuses what it finds. Otherwise it runs the eval and files a
  report with `--if-none-match '*'`. When two runs race, the first stands.
- Every report names its fingerprint, commit, model id and the URL of the
  run that produced it, and holds every go/no-go row. `evals/report.ts`
  refuses one without them.
- The bucket's policy refuses any write under `eval/` or `eval-reports/`
  that does not ask S3 to refuse it when the key exists.
- Only the CI eval role writes to `eval-reports/`, and it trusts only the
  `eval` environment. The run writes under `eval/`, never `eval-reports/`.
- `access-eval`, a session's `grantlink-eval` profile, may only
  `s3:GetObject` on `eval/*`, and denies everything else.
- A session's eval runs are advice. They never enter the cache.
- Logs print paper ids and scores, never text (personal-data.md).

## Do not

- Fetch the gold sets' text from Europe PMC on every run. It is slow and
  fragile, and scores drift with changes upstream.
- Commit the snapshot's text to the repo. It republishes article text and
  names in a public repo. `.eval/` is ignored for this reason.
- Decide whether to run the eval from the files a change touched. The diff
  base differs between a pull request and main, and a revert reads as new.
- Let a session file a report. The scores on a pull request must come
  from CI.
- Overwrite a report or a snapshot file, even to fix one. Take a new
  snapshot id, or change an input so the fingerprint moves.

## Judgment

The first report for a fingerprint stands, so the eval never measures the
model's run-to-run variation. The canary in each weekly run watches for
drift instead. Whether a new input that can change a score sits inside the
fingerprinted paths is for review: the lint rule sees imports, not files
read at run time.

History: #9
