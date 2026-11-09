# grantlink

grantlink finds research papers that say Cancer Research UK funded them but that Europe PMC links to no CRUK grant. It reads the grant reference from each paper's funding text, publishes the links, and publishes how the service is run: the go/no-go criteria set before the build, the evals that gate every release, and the check behind every limit it works within.

It is an independent demonstration on public data from [Europe PMC](https://europepmc.org/). It is not affiliated with or endorsed by Cancer Research UK.

The plan is the PRD, [#1](https://github.com/t-d-d/grantlink/issues/1). The decisions behind it are the issues labelled `type: adr`, and the rules in force are in [docs/constraints/](docs/constraints/README.md).

## Licence

The code is under the Apache License 2.0. The licence covers the code only. Paper titles and funding text belong to their publishers, under each paper's own licence.
