# Durable execution
Relevance: A run's durable body or its steps, src/run/**, or anything that takes a durable context
Decision: A run is one Lambda Durable Function execution. Every I/O, clock and random read sits in a checkpointed step, and the body branches only on step results.

Why: A run reads about 5,500 papers once, then about 50 a month, and must
survive a failure partway without redoing finished papers or losing any.
On every resume the SDK runs the body again from the top, hands back the
saved result of each finished step, and runs everything else afresh. A body
that reads live state takes a different path on replay than the one its
checkpoints recorded, and the SDK stops the run with
`NonDeterministicExecutionError`. Adapted from podstow's
`durable-execution.md` and `durable-step-contract.md`.

## Rules

- Code that takes a durable context lives in `src/run/`. Helpers that a
  step calls, such as the Europe PMC client, the rules or the stores, live
  outside it and take no context.
- Every I/O call, every clock read and every random read happens inside a
  `ctx.step`, and the body branches only on what a durable operation
  returned. `grantlink/no-await-outside-step` and
  `grantlink/no-non-deterministic-outside-step` check this.
- A step's callback returns its result. It does not change a variable
  from outside it, which a replay would skip.
  `grantlink/no-closure-in-durable-operations` checks this.
- A durable operation never uses the context of an operation it sits
  inside. Nest through `runInChildContext` and use the child.
  `grantlink/no-nested-durable-operations` checks this.
- Every step passes an explicit `retryStrategy`. Europe PMC's terms ask
  for back-off whenever it refuses or slows a request, and a failed model
  call leaves its paper for the next run.
  `grantlink/require-step-retry-strategy` checks this.
- Step names are unique within a run. A loop puts a deterministic counter
  or the paper's id in the name (`paper-${pmcid}`). A loop whose count
  depends on live state reads that state in a step first.
- A step whose result decides what happens next reads and decides in the
  same step, and returns a tagged union the body branches on. It must be
  safe to run twice: a conditional write catches its own conflict and
  reads the row instead.
- A fan-out over papers takes its list from a step's result, never from a
  value computed again in the body.
- A run starts on a published Lambda version, never `$LATEST`, so a deploy
  never changes the code of a run in progress.
- A step's name, position and result shape are a contract with every run
  in progress on that version. Rows a later version reads from the table
  are read tolerantly: a new field is optional.

## Do not

- Read the table, the bucket, Europe PMC or the clock outside a step and
  branch on it. A replay reads it again and walks a different branch.
- Wrap each arm of a conditional in its own `runInChildContext` to hide a
  divergent branch. The SDK checks each operation's name and type by
  position, so it still fails.
- Put a whole `Promise.all` in one step that catches and carries on. The
  same input then gives a different result depending on which call
  failed.
- Keep per-run caches at module scope. Lambda reuses the module between
  runs, so stale state leaks from one run into the next.
- Rely on the SDK's default retries. Nobody here chose them.

## Judgment

The lint rules see the shape of the code, not what it means: whether a
deciding step is safe to run twice, whether a fan-out's list really came
from a step, and whether a new field is read tolerantly are for review.
A per-line `eslint-disable-next-line` for one of these rules names the rule
and says why the line is replay-safe.

History: #5
