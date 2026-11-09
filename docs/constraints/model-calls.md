# Model calls
Relevance: Calling a model, the prompt, the model id, OpenRouter, or a model client package; src/extract/model.ts
Decision: One module calls the model through OpenRouter, pinned to one model and routed only to Anthropic. A reference not found in the source text is rejected.

Why: The model reads funding text and proposes grant references. A
plausible invented grant number would pollute every later count, and
funding text is input from outside that could carry instructions. One
module means one place that pins the model, routes the request, marks the
text as data and checks the reply. OpenRouter rather than Anthropic's API
lets a session run the eval with the key as a network secret, which a
Claude environment refuses for Anthropic's own hosts.

## Rules

- `src/extract/model.ts` is the only module that calls OpenRouter, names
  a model id, or imports a model client. The model id is set there once.
  `grantlink/model-call-in-model-module` checks this in `src/` and
  `evals/`.
- Every request names Anthropic as its only provider, with fallback to
  other providers turned off.
- The request sends only funding text, marked as data.
- The reply is parsed with a Zod schema. A malformed reply is retried
  once, and then the paper stays unprocessed for the next run. A model
  result is never guessed.
- A reference the model returns must appear in the source text as
  written. The check runs on the reference as written, before it is
  normalised.
- Thresholds set from the eval, and a person, decide what is accepted.

## Do not

- Call Anthropic's API directly. A session could then not run the eval
  without seeing the key, and every change to the prompt would wait on an
  Actions run.
- Name the model id a second time, in the eval or anywhere else. Import
  it from the model module.
- Normalise a reference before checking it against the text. The check
  would then pass references the paper never wrote.

## Judgment

The tests that need the model module land with it in #24: every request
names Anthropic as its only provider with fallbacks off, a reply naming a
reference absent from the text is rejected, and a malformed reply is
retried once and then left for the next run. Until then they are for
review. Tests are left out of the lint rule.

History: #7
