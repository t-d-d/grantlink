# Europe PMC's terms
Relevance: src/europepmc/client.ts, how often or how fast the service calls Europe PMC, its retries, its User-Agent, or the credit to Europe PMC
Decision: Calls to Europe PMC run at about 2 a second, back off whenever it refuses or slows a request, and name the service. Europe PMC is credited.

Why: The service reads Europe PMC's web services under the EMBL-EBI terms
of use, which ask callers to keep to a modest rate, to back off when
asked, to say who they are, and to credit Europe PMC. The back catalogue
is about 5,500 papers, so a careless run would be a burst of thousands of
requests.

## Rules

- At least half a second passes between the starts of two requests, so a
  run makes about 2 a second.
- A refusal (429) or a server error waits as long as Europe PMC's
  `Retry-After` asks, or longer after each try with none. A request slower
  than five seconds halves the pace until Europe PMC is quick again.
- The client waits at most a minute within one try. A `Retry-After`
  longer than that ends the try, and the run waits instead, so a long
  wait never holds a Lambda invocation open.
- After a refusal with a `Retry-After`, no request goes to Europe PMC
  until that wait has passed. The run waits durably, not by retrying a
  step, and a wait still owed is waited out just before the next request.
- After five tries a request gives up. The run's step asks again after a
  longer wait, and after that the paper waits for the next run. A paper
  with no full text (a 4xx other than 429) is not asked for again in that
  run.
- Every request carries a User-Agent that names grantlink, its address and
  a contact.
- The back catalogue goes through the same web services, once. A paper
  already read is not fetched again.
- The page and the README credit Europe PMC, with links to it and to the
  EMBL-EBI terms of use (licence.md).

## Do not

- Run requests in parallel to finish sooner. The pace is the point.
- Download Europe PMC's bulk open-access files to get round the pace. The
  service needs a few thousand papers, not the whole archive.
- Rely on a step's retries alone. They come after the client's own
  back-off, not instead of it.

## Judgment

The unit tests drive the client with a fake clock and a fake Europe PMC.
Whether the deployed run keeps to the pace across Lambda invocations rests
on the client being made once per invocation and each batch ending with a
wait, which is for review.

History: #1, #143
