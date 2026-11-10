# Storage
Relevance: Reading or writing the results table or the funding text bucket, src/store/**, or adding a DynamoDB or S3 client anywhere
Decision: Results go in one on-demand DynamoDB table and funding text in one private, encrypted S3 bucket. One module reads and writes each.

Why: The page's counts and the review queue read one table. Evals and
re-processing read each paper's funding text from the bucket, so they never
fetch it again from Europe PMC, and scores do not drift with changes there.
One module for each store means one place that checks what goes in, so
funding text or a name cannot slip into the table through a second writer.

## Rules

- `src/store/table.ts` is the only module that imports the DynamoDB
  clients, and `src/store/bucket.ts` the only one that imports the S3
  clients. Neither imports the other's. `grantlink/only-owner-imports`
  checks this in `src/` and `evals/`.
- The table is on demand and holds each paper's metadata, its extraction,
  its decision and the versions that made it. It holds no funding text and
  no names (personal-data.md).
- Besides one row per paper, the table holds one item keyed
  `latest-search`. It holds the id of the latest-started run whose search
  completed, and no funding text and no names.
- The bucket is private and encrypted, and has three prefixes: `cache/`
  for each paper's funding sections, `eval/` for the fixed eval snapshot,
  and `eval-reports/` for eval reports.
- Both stores live in eu-west-2.
- `src/store/bucket.ts` also publishes the page to the page's own bucket,
  since it alone may import the S3 clients. It writes only `index.html` and
  `found.json` there.
- A paper removed on request goes from both stores.

## Do not

- Keep everything in S3 as JSON. The page's counts and the review queue
  need queries that S3 cannot answer cheaply.
- Use Postgres, on RDS or Aurora Serverless. It brings idle cost or cold
  starts, and a schema to migrate, for a few thousand rows.
- Stop storing funding text to avoid holding personal data. Evals would
  download the same papers on every run, scores would drift with changes
  at Europe PMC, and every release would depend on Europe PMC being up.

## Judgment

`src/store/table.test.ts` checks that the table module refuses a row with
a field outside its schema. `test/run.static.ts` reads the template for a
private, encrypted bucket, and `test/text-bucket.conformance.ts` reads the
deployed bucket for the same, since a setting changed in the console does
not show in the template. Tests are left out of the lint rule, because a
conformance check reads the bucket with S3's own client.

No check reads what the `latest-search` item holds. `recordSearch` in
`src/store/table.ts` writes only its run id, so read any change that writes
more there against the rule above.

History: #6, #213
