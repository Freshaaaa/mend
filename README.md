[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Freshaaaa/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Freshaaaa/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format — a make.fun entry for
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

`mend` applies an edit that an AI model wrote to a tree of text files, in one
of four formats — unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON — following
`SPEC.md`. It finds the lines each edit names at the first of three matching
tiers, and changes every file or none at all.

Run it as `node main.ts [options] [PATCH]` (Node 22, standard library only).
