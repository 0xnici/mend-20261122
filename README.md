# mend-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/0xnici/mend-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/0xnici/mend-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a zero-dependency Node 22 CLI that applies AI-written edits — unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits — to a tree of text files, all-or-nothing, with three-tier line matching. Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Run it

```sh
node main.ts [options] [PATCH]
```

## What it does

`mend` reads a patch in one of four formats (auto-detected, or forced with `--format=NAME`), finds the lines each edit names at the first of three matching tiers — exact, ignoring trailing whitespace, ignoring leading and trailing whitespace with re-indentation — and writes every change or none. `--check` previews without writing; `--strict` matches exactly.

- `node main.ts patch.diff` — apply a unified diff
- `node main.ts --format=search-replace edits.txt` — apply SEARCH/REPLACE blocks
- `node main.ts --format=v4a -` — apply a V4A patch from stdin
- `node main.ts --format=json edits.jsonl` — apply JSON edits
- `node main.ts --check patch.diff` — same output and exit code, no files written

`SPEC.md` is the whole contract. `check.ts` runs the 100 public practice checks against `main.ts`; `runner.ts` is the kit's trial runner, kept as shipped.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
