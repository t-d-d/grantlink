# Gold set B: the labelling guide

Gold set B is 100 open-access papers that name Cancer Research UK in their
funding or acknowledgement text, but that Europe PMC links to no CRUK grant
(#3). You label each one by hand in the sheet, against this guide (#22).
Your labels are the answers the eval scores the rules and the model
against, so they say what the paper itself says, nothing more.

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

Never copy the paper's sentences or anyone's name into the sheet, the
note included. The sheet holds ids and labels. The paper's text stays on
Europe PMC (`docs/constraints/personal-data.md`).

## Finding the funding statement

1. Open the link in the `europe_pmc` column. Every paper in the sample has
   its full text on Europe PMC.
2. Use your browser's find for each of `Cancer Research`, `CRUK` and
   `U.K.`, and read every place they appear.
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
or thanks to CRUK staff for something other than funding.

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
- every letter in upper case.

This is the form the rules produce (`src/extract/rules.ts`).

| As written | Normalised |
| --- | --- |
| `C1234/A56789` | `C1234/A56789` |
| `c 1234 / a 56789` | `C1234/A56789` |
| `A12345` | `A12345` |
| `ABCDEF\100001` | `ABCDEF/100001` |
| `ABCDEF-2021∖100002` | `ABCDEF-2021/100002` |
| `ABCDE-Jun24/100003` | `ABCDE-JUN24/100003` |

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

`funded`: `unclear`. References: blank. Note: `facility thanked, no
funding stated`.

### An affiliation only

CRUK is named only as where someone works.

> Funding: This work was funded by the Exampleshire Cancer Charity.
>
> Acknowledgements: One author is based at the Cancer Research UK
> Exampletown Institute.

`funded`: `no`. References: blank. Note: `affiliation only`.

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

## When you are done

Every row has `funded` set, and its references where it has any (#22).
Export the sheet as CSV. #23 commits the ids and labels to the repo, and
nothing else from the sheet.
