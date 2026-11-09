# No republished article text
Relevance: The page, site/**, src/page/**, found.json, or anything the service publishes from a paper
Decision: The page shows only each paper's title, its link to Europe PMC and its grant references, never an abstract or any of its text.

Why: Papers in Europe PMC's open-access subset are still under copyright,
each under its own licence. A title, a link and a grant reference say what
the service found without republishing the paper. Funding text also names
people (personal-data.md).

## Rules

- The page and `found.json` carry, for each paper, its PMCID, its title,
  and each reference as written, normalised and by format. Nothing else of
  the paper.
- The schema in `src/page/found.ts` refuses any other field, and the page
  is built only from it.
- Each title links to the paper on Europe PMC, where a reader finds the
  reference in its own funding text.

## Do not

- Quote the sentence a reference came from, to show it is real. The link
  shows it, on Europe PMC, under the paper's own licence.
- Show the abstract to say what a paper is about. The title does that.

## Judgment

A title can carry a name, as in a paper about a person. The PRD accepts
titles, so that is not a breach, but a title shown in full is the only
text of a paper the page holds.

History: #1
