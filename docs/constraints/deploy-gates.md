# Deploy gates
Relevance: .github/workflows/deploy.yml, .github/workflows/eval.yml, the release record in src/page/release.ts, the prod or eval environment, or the deploy role
Decision: Only a green merge to main deploys, and only with an eval report for main's own fingerprint at or above every gating floor.

Why: grantlink shows an AI service going into production safely. A change
to the rules, the prompt or the model can make results worse without any
test failing. Every live release must be traceable to the eval that covers
it.

## Rules

- `deploy.yml` runs only on a push to main. Nobody deploys by hand.
- Its deploy job needs the gate and the eval, which `deploy.yml` calls as
  `eval.yml` for main's own commit.
- Before it deploys, the job computes main's fingerprint, refuses a report
  filed for any other, and refuses a report below a gating floor
  (`node evals/check.ts gate`).
- A pull request's eval job fails when its report is below a gating floor,
  so it cannot merge once the `eval` check is required (#21).
- A gating row with no data yet, such as a gold set B row before its
  snapshot is pinned, shows what it waits for and does not block.
- The deploy records the release in `site/release.json`: its commit, its
  fingerprint, the report with the run that produced it, and the deploy's
  own run. `src/page/release.ts` refuses a record without them. The record
  ships with the function and the page, and the page shows it under "How
  it's run".
- The `prod` environment allows only main, and the deploy role trusts only
  `prod`. The `eval` environment allows every branch.
- The pull request gets one comment with CI's scores beside the live
  release's, updated on each run.

## Do not

- Deploy from a laptop. Nothing stops a bad change, and it shows the
  opposite of the point.
- Run the eval nightly, apart from deploys. A bad release would ship and
  stay live until the next run.
- Add a staging environment. The eval and the canary test what matters,
  and a second environment doubles the setup.
- Require branches to be up to date before merging. Main checking its own
  fingerprint closes the same gap without slowing every merge.

## Judgment

The static checks read the workflows. Whether `prod` allows only main is
GitHub's setting, which `test/environments.conformance.ts` reads. A
combination that fails on main stops the deploy until a fix lands, and the
page keeps the last release meanwhile.

History: #8
