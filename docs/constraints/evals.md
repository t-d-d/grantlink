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
  once: each gold paper's funding sections at
  `eval/<id>/papers/<pmcid>.json`, under its own snapshot id, and a
  manifest at `eval/<id>/manifest.json` listing each paper, its set, its
  text's SHA-256 and, for gold sets A and A2, its answers.
- Gold set A is sampled once, with the query, seed and size recorded in
  `evals/gold-a.json`. A candidate joins it only if its full text prints
  at least one of the CRUK grants Europe PMC links it to. Its answers are
  the linked grants it prints. A funder registry id is never an answer.
  Once the snapshot exists, `node evals/pin.ts` pins
  the manifest's hash in `evals/snapshot.json` and copies gold set A's ids
  and grant ids into `evals/gold-a.json`. Gold set B's labels live in
  `evals/gold-b.json`. A new gold paper needs a new snapshot id, which
  starts unpinned. An unpinned snapshot scores nothing, so its rows wait
  and do not block until it is taken and pinned.
- Gold set A2 is a held-out draw of gold set A: 300 papers drawn as gold
  set A is, with the same query and its own seed, from candidates not in
  gold set A. Its answers are found as gold set A's are.
  `node evals/pin.ts` copies its ids and grant ids into
  `evals/gold-a2.json`.
- Gold set B2 is 100 papers drawn once, at random, from the live search
  less gold set B's papers, with the query, seed, date and size recorded
  beside its ids in `docs/gold-set-b2-sample.json`. Its labels live in
  `evals/gold-b2.json`. The snapshot keeps its papers as set `B2`, as it
  keeps gold set B's, even with empty sections.
- Gold sets A2 and B2 are held out. Nobody changes the rules or the prompt
  because of a paper or reference in either. A report gives their scores
  and never the ids of the papers or references they missed.
- Gold set A2's and B2's rows are reported and do not gate.
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
- Before the first deploy creates the private bucket, nothing can be
  pinned or filed. The eval then scores no gold set, files nothing, and
  hands its report to the deploy, so the first deploy is not blocked.
  After a deleted stack the bucket is missing though a snapshot is
  pinned. The eval treats that the same way, downloads nothing, and the
  runner scores as if nothing were pinned, so the deploy that makes the
  bucket again is not blocked.
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
- Read gold set A2's or B2's misses to change the rules or the prompt.
  Their scores would then measure the tuning, as gold sets A's and B's do.

## Judgment

The first report for a fingerprint stands, so the eval never measures the
model's run-to-run variation. The canary in each weekly run watches for
drift instead. Unpinning the snapshot makes every gold row wait, so a pull
request that sets `manifestSha256` to null without a new snapshot id is for
review. Whether a new input that can change a score sits inside the
fingerprinted paths is for review: the lint rule sees imports, not files
read at run time. Whether a change to the rules or the prompt came from gold
set A2 or B2 is for review.

History: #9, #502, #695, #253
