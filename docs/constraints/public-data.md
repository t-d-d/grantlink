# Public data only
Relevance: Reading anything from outside the service, src/europepmc/**, a new data source, or any code that makes an HTTP request
Decision: The service reads only Europe PMC's open-access papers, through its public web services, and one module makes those calls.

Why: grantlink is a demonstration on public data. A paper it could only
read through a login, a licence or a scraped page would make its findings
something nobody else could check, and might break the terms the paper is
published under. One module for the calls means one place to see what the
service reads.

## Rules

- `src/europepmc/client.ts` is the only module that fetches papers. It
  calls only `www.ebi.ac.uk`, over HTTPS, under Europe PMC's REST path, and
  refuses any other host.
- The search asks only for open-access papers with their full text in
  Europe PMC (`OPEN_ACCESS:y`, `IN_EPMC:y`).
- No other module in `src/` makes a request of its own. The model module
  calls OpenRouter, under model-calls.md.
- The funder is named in `src/extract/funder.json`, not in the code, so
  the same search serves another funder by a change of config.

## Do not

- Read closed-access papers through a publisher's site. Their full text is
  not public, and the PRD leaves them out.
- Scrape Europe PMC's web pages. Its web services are the public way in,
  and its terms (europe-pmc.md) cover them.
- Fetch a paper from a second source when Europe PMC fails. The paper
  waits for the next run instead.

## Judgment

The static check reads the source for a request. A request made some
other way, such as through an SDK that is not an AWS client, is for
review.

History: #1
