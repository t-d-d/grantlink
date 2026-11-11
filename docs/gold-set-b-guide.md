# Gold set B: the labelling guide

Gold set B is 100 open-access papers that name Cancer Research UK in their
funding or acknowledgement text, but that Europe PMC links to no CRUK grant
(#3). Two model passes propose each paper's labels against this guide,
and you check the rows they flag, the rows you settled, and a random
sample of the rest in the sheet (#22, #175). The labels are the answers the eval scores the rules
and the model against, so they say what the paper itself says, nothing
more.

The eval scores only the references. `funded` and `note` help whoever
checks a row, and `evals/gold-b.json` keeps only each paper's references.

The sample and how it was drawn are in `docs/gold-set-b-sample.json`. The
sheet's rows are in `docs/gold-set-b-sheet.csv`.

Every example below is made up. The grant numbers are invented and the
people are described by role. No example quotes a real paper.

## What goes in each column

| Column | What to write |
| --- | --- |
| `pmcid` | Filled in. The paper's id. |
| `europe_pmc` | Filled in. The paper's page on Europe PMC. |
| `funded` | `yes`, `no` or `unclear`. |
| `references_as_written` | Each CRUK grant reference exactly as the paper prints it, separated by `; `. Blank if there is none. |
| `references_normalised` | The same references normalised, in the same order. Blank if there is none. |
| `note` | Why, when the answer is `unclear` or the case is hard. A few words. |
| `passes` | Filled in. `passes agreed`, `a pass was unsure`, `passes differed on funded`, or `settled with you` for the 18 papers you settled while setting the rules. |
| `look_in` | Filled in. Where in the paper the passes found CRUK's funding or references. |
| `checked` | `y` once you have checked the row and fixed anything wrong, `y, sample` for an agreed row the sample drew, or `agreed, not checked` for an agreed row the sample stands for. |

The sheet's `proposed` tab keeps the passes' labels as they were. Leave it
alone: #23 compares it with your labels to count how many you changed.

Never copy the paper's sentences or anyone's name into the sheet, the
note included. The sheet holds ids and labels. The paper's text stays on
Europe PMC (`docs/constraints/personal-data.md`).

## Checking a proposed label

Check the references first, as they are what the eval scores. Check every
row marked `settled with you`, `a pass was unsure` or `passes differed on
funded`. Of the rows marked `passes agreed`, check 10 drawn at random with
a recorded seed.

1. Open the paper and go to the place `look_in` names.
2. Find each proposed reference with your browser's find. Check that the
   text ties it to CRUK by one of the rules below, and that
   `references_as_written` matches the print character for character.
3. Find `Cancer Research`, `CRUK`, `CR-UK` and `U.K.` too, and read every
   place they appear, for any CRUK reference the passes missed.
4. Fix `funded`, the references or the note if they are wrong, and put `y`
   in `checked`.

## Finding the funding statement

1. Open the link in the `europe_pmc` column. Every paper in the sample has
   its full text on Europe PMC.
2. Use your browser's find for each of `Cancer Research`, `CRUK`, `CR-UK`
   and `U.K.`, and read every place they appear. Another charity's name
   can contain `Cancer Research, UK`, so read the whole name.
3. Check each of these, as each journal puts funding in a different place:
   - a section headed Funding, Financial support or Grant support, in the
     body or near the end;
   - the Acknowledgements;
   - footnotes under the title or the author list, such as Funding
     information or Supported by;
   - Competing interests, Conflicts of interest or Declaration of
     interests;
   - the author affiliations.
4. Europe PMC may list the funders it has linked to the paper. By how the
   sample was drawn, none of them is a CRUK grant, so that list does not
   answer the question. Read the paper's own text.

Label only what the paper says. Do not look a grant up elsewhere, and do
not count a grant you know about that the paper does not state.

## Funded: yes, no or unclear

**Yes** when the paper says CRUK paid for any part of the work it
reports: a grant, a programme, a fellowship or studentship held by an
author for this work, core funding to a CRUK centre or institute that the
paper says supported the work, or a CRUK-funded trial or study the paper
says funded it.

**No** when CRUK is named, but the paper does not say CRUK funded this
work. The usual reasons are an author's declared interest, an affiliation,
or thanks to CRUK staff for something other than funding. An affiliation
or a facility alone is `unclear` instead when the paper has no funding
statement (rule 1 below).

**Unclear** when you cannot tell from the text. Say why in the note, in a
few words of your own.

## References: as written and normalised

A reference counts when the text ties it to CRUK, by sitting next to
CRUK's name or in CRUK's place in a list. Record only CRUK's references,
never another funder's.

**As written** is the reference character for character, with its spaces,
slashes, backslashes and case as printed. If the paper writes the same
reference twice in different ways, record each way once.

**Normalised** is the same reference with:

- every space removed;
- every backslash (`\`) and set minus sign (`∖`) turned into a forward
  slash (`/`);
- every letter in upper case;
- every Unicode hyphen or dash, such as `‐` (U+2010), turned into `-`;
- a `CRUK` printed straight onto the front of a reference, with no space
  or separator between them, as in `CRUKC1234/A56789`, dropped. A
  reference whose own form starts with `CRUK/` or `CRUK-` keeps it.

The rules produce the same form (`src/extract/rules.ts`), except for the
last step: the rules do not yet read a reference with `CRUK` joined to its
front.

| As written | Normalised |
| --- | --- |
| `C1234/A56789` | `C1234/A56789` |
| `c 1234 / a 56789` | `C1234/A56789` |
| `A12345` | `A12345` |
| `ABCDEF\100001` | `ABCDEF/100001` |
| `ABCDEF-2021∖100002` | `ABCDEF-2021/100002` |
| `ABCDE-Jun24/100003` | `ABCDE-JUN24/100003` |
| `ABCDE‐Jun24/100003` | `ABCDE-JUN24/100003` |
| `CRUKC1234/A56789` | `C1234/A56789` |

Leave a reference out, and say so in the note, when:

- the text gives a number but you cannot tell whether it is CRUK's;
- the "reference" is a trial registration, an ethics approval or a
  project number from another body.

If CRUK funded the work but the paper gives no reference, `funded` is
`yes` and both reference columns are blank.

## The hard cases

Each of these is in the sample at least twice. The draw picked two papers
for each by a check on its text, which is a guess at the case and not a
label. Label each paper on its own text.

### A declared interest

CRUK is named in the competing interests, not as a funder of this work.

> Funding: This study was funded by the Medical Research Council
> (MR/X000000/1).
>
> Competing interests: One author has received research grants from Cancer
> Research UK, outside the submitted work.

`funded`: `no`. References: blank. Note: `declared interest only`.

If the funding section also says CRUK funded this work, the declared
interest does not change that: label from the funding section.

### Centre or institute support

CRUK funds a centre or institute, and the paper names it.

> This work was supported by the Cancer Research UK Exampletown Centre
> (C9999/A99999) and by core funding to the CRUK Exampletown Institute.

`funded`: `yes`. As written: `C9999/A99999`. Normalised: `C9999/A99999`.
Note: `centre and institute core funding`.

> We thank the CRUK Exampletown Institute's imaging facility for their
> help.

`funded`: `no` when the paper's funding statement leaves CRUK out, and
`unclear` when the paper has no funding statement. References: blank.
Note: `affiliation or facility only`.

### An affiliation only

CRUK is named only as where someone works.

> Funding: This work was funded by the Exampleshire Cancer Charity.
>
> Acknowledgements: One author is based at the Cancer Research UK
> Exampletown Institute.

`funded`: `no`. References: blank. Note: `affiliation or facility only`.

### Several funders

CRUK is one of several funders, each with its own reference.

> This work was funded by Cancer Research UK (C1111/A22222), the Wellcome
> Trust (123456/Z/20/Z) and the National Institute for Health and Care
> Research (NIHR111111).

`funded`: `yes`. As written: `C1111/A22222`. Normalised: `C1111/A22222`.
The other funders' references are left out.

> Supported by Cancer Research UK and the Exampleshire Cancer Charity
> (grants 2020-01 and DEFGHI\100004).

`funded`: `yes`. As written: `DEFGHI\100004`. Normalised:
`DEFGHI/100004`. Note: `matched by CRUK's format`. If neither number
looked like CRUK's, both would be left out, with the note `cannot tell
which reference is CRUK's`.

### CRUK named with no reference

> This work was supported by Cancer Research UK.

`funded`: `yes`. References: blank. Note: `no reference`.

## Rules agreed while labelling

You settled these on 18 papers the guide left open (#175).

1. **An affiliation or a facility only.** CRUK named only in an
   affiliation, or as a facility the authors used, is `no` when the paper's
   funding statement leaves CRUK out, and `unclear` when the paper has no
   funding statement.
2. **CRUK's own format.** A reference like `C1234/A56789` counts even when
   the text credits it to a CRUK-funded centre, as in "the Example Centre
   of Excellence (C1111/A22222)". Note: `matched by CRUK's format`.
3. **The Francis Crick Institute.** "Supported by the Francis Crick
   Institute, which receives its core funding from Cancer Research UK
   (FC001234), the Medical Research Council (FC001234) and Wellcome
   (FC001234)" is `yes`, with `FC001234` once. The newer `CC2001` style
   counts the same way. With no number, it is `yes` and the references are
   blank.
4. **"CRUK" joined to a reference.** As written keeps `CRUKC1234/A56789`.
   Normalised drops the `CRUK`: `C1234/A56789`.
5. **Consortium funding.** When the paper's funding section lists the CRUK
   grants behind a consortium or cohort whose data it used, every one
   counts. Note: `consortium funding listed`.
6. **Malformed or truncated.** Record a reference as printed, such as
   `C1234 /A567`, and never correct it. Note: `looks truncated`.
7. **Generic support.** "The authors acknowledge support from Cancer
   Research UK" in a funding or acknowledgement passage is `yes`.
8. **Pooled schemes.** "Supported by the Example Prevention Partnership
   (MR/X000000/1), which ten funders including Cancer Research UK fund" is
   `yes`, but the number is the other funder's and is left out. Note:
   `pooled scheme, number is not CRUK's`. A joint award named for CRUK, as
   in "the Example-Cancer Research UK Challenge Award RT1234", counts.

A bare number counts when the text ties it to CRUK by name, as in "a CRUK
Example grant (12345)". Never count a DOI funder-registry number
(`10.13039/…`), a GRID or ROR id, an ORCID, an ethics approval, a trial
registration or a dataset accession.

## Gold set B2

Gold set B2's labels follow this guide too (#695). Its sheet,
`docs/gold-set-b2-sheet.csv`, has one more column, `flag`, which gives
every reason to check the row (#700):

- `passes differ`: the two passes gave a different `funded` or different
  references. The sheet proposes the first pass's labels.
- `a pass was unsure`.
- `differs from the rules`: the rules found other references in the
  paper's funding sections.
- `differs from <model id> alone`: that model, reading the funding
  sections with no rules, found other references.
- `sample`: one of 10 rows nothing else flagged, drawn at random with the
  seed in `docs/gold-set-b2-sample.json`.
- `agreed, not checked`: none of the above.

Its `passes` column can also say `passes differed on references`. When
the passes compared in more than one way, it gives each way, separated by
`; `. Leave `passes`, `flag` and `look_in` as they are.

A flag says only that a row differs, not which reference, so read the
paper afresh. Check every flagged row and every `sample` row. If the
sample finds an error, check every row. `docs/gold-set-b2-proposed.csv`
keeps the proposals as they were, and `docs/gold-set-b2-passes.csv` keeps
each pass's own labels. Leave both alone.

`docs/gold-set-b2-sample.json` records the model that made the passes,
the versions of the rules and the prompt, and the models that read the
papers alone.

## When you are done

Every row has `funded` set, its references where it has any, and
`checked` filled in (#22). Export the main tab and the `proposed` tab as
CSV. #23 compares the two, and commits the ids and references to the
repo, and nothing else from the sheet.
