# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/shadowmartin347-web/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/shadowmartin347-web/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — and mend reads all four to one written specification (`SPEC.md`), finds
the lines an edit names even when the model drifted their whitespace or
indentation, and changes every file or none.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22 and its standard library only; nothing is installed. The working
directory is the root of the tree; PATCH is the patch file (or `-`, or nothing,
to read the patch from standard input).

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a`, `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`) and
`ok: <n> files`. Exit 1 lists each failed edit and `failed: <k> of <n> edits`;
no file is written. Exit 2 reports a usage, missing-patch, format or parse
error on one line.

Matching works in three tiers: exact lines, then lines equal once trailing
spaces and tabs are removed, then lines equal once leading and trailing spaces
and tabs are removed. Unified hunks take the occurrence nearest the hunk's
stated line number; SEARCH/REPLACE blocks fail as `ambiguous` when the old
lines occur more than once; V4A chunks walk a cursor through the file from
their anchor. Unsafe paths (absolute, empty, or escaping the tree) are refused,
and a failed edit never writes anything.

## Practice checks

The kit's practice set (100 checks with the house reference's expected
outcomes) is run with the starter's checker:

```sh
node check.ts <practice.json>
```

This entry scores 1000/1000 on the practice set.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
