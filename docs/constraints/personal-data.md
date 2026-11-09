# Personal data
Relevance: Logging, the page, fixtures and recorded responses, or anything that handles funding text, acknowledgements or names
Decision: Funding text and the names in it exist only in the private bucket and in the model call. Logs carry ids and counts.

Why: Funding statements name people, and UK GDPR applies. The task needs
the reference, not the person. The repo and the page are public, and
sessions working from public issues could be steered into pasting text
somewhere public.

## Rules

- Funding text, acknowledgements and names are kept only in the bucket
  (storage.md) and sent only in the model call (model-calls.md).
- The table, the logs, the page, the repo, issues and pull requests never
  carry funding text or names.
- A log line carries ids and counts. No logger or `console` call carries
  a field or a value for funding text, acknowledgements, sections or
  names. `grantlink/no-banned-log-fields` checks this in `src/` and
  `evals/`.
- A recorded response in the repo comes only from a paper under CC BY or
  CC0, cut to the funding sections, with its names replaced, and is
  listed with its source and licence.
- Never paste funding text into an issue, a pull request, a commit or a
  log.

## Do not

- Remove names before storing or sending the text. That needs reliable
  name detection, its mistakes would cost accuracy, and a missed name
  breaks the promise anyway.
- Show names with each link, as attribution. The task does not need them,
  and the page would become a list of people.
- Log a paper's text to look into a bad extraction. Read it from the
  bucket through the eval role or the deploy role.

## Judgment

The lint rule matches names: a field called `detail` that holds funding
text gets past it, so what a log line carries is also for review. Two
checks need code that lands in #19: a unit test that the page built from
fixtures with known names contains none of them, and a static test that
every recorded fixture is listed in its sources file with a CC BY or CC0
licence and its names replaced. Nothing a machine runs keeps funding text
out of issues and pull requests; each session's instructions do.

History: #10
