# Commits

[Conventional Commits](https://www.conventionalcommits.org/),
**strictly enforced**. `tools/check-commits.sh` runs in CI on every
push and PR (right after checkout, before all other gates) and fails
the build on the first violation. Run it locally before pushing:

```sh
sh tools/check-commits.sh        # checks origin/main..HEAD
pnpm check:commits                # same via package script
sh tools/check-commits.sh <range> # e.g. HEAD, HEAD~3..HEAD
```

A malformed commit breaks release automation (release-please derives
version bumps and `CHANGELOG.md` entries from these messages), so
fix the message (`git commit --amend`, or reword + force-push on a
PR branch) rather than working around the check.

## Format

```
<type>(<scope>)(!): <subject>
```

- `type`: one of the table below, lowercase. Anything else
  (`Feature:`, `wip:`, `fix(scope):` with a capital, bare `update …`)
  fails.
- `scope`: optional, lowercase letters/digits plus `_`, `.`, `/`, `-`
  (e.g. `feat(cli/auth): …`). Omit it when the change is repo-wide.
- `!`: marks a breaking change; requires a `BREAKING CHANGE:`
  footer in the body (machine-checked).
- `subject`: imperative mood, starts lowercase, no trailing period.
- Header (the whole first line) ≤ 72 chars.
- Body (optional): explain *why*, not *what*. Required only for `!`.
- Merge commits (`Merge …`) are skipped by the check.

## Types and release effect

| Type | Meaning | release-please effect |
| --- | --- | --- |
| `feat` | new user-facing behavior | minor bump + CHANGELOG entry |
| `fix` | bug fix | patch bump + CHANGELOG entry |
| `docs` | docs only | none |
| `refactor` | no behavior change | none |
| `test` | tests only | none |
| `chore` | tooling, deps, housekeeping | none |
| `ci` | CI config | none |
| `build` | build/packaging | none |
| `!` suffix | breaking change (any type) | major bump |

Types outside this list fail the check — there is no `wip`, `style`,
`perf`, or `revert` type in this repo.

## Good vs bad

```text
feat: add audit mode
fix(cli): reject symlink escapes in target resolution
docs: document release-please flow
feat(api)!: drop legacy output shape

BREAKING CHANGE: --json is now the only output flag.
```

```text
Fix: add audit mode          # capital type
feat: Add audit mode         # capital subject
feat: add audit mode.        # trailing period
update stuff                 # no type at all
feat(api)!: drop legacy shape # no BREAKING CHANGE: footer
```

## Breaking changes

Append `!` after type/scope **and** add a `BREAKING CHANGE:`
footer describing the break and the migration. The check enforces
both halves — `!` without the footer (or vice versa) fails.

## Releases

Version bumps, tags, and `CHANGELOG.md` are automated by release-please
from these commit messages. Do not bump `version` manually — a `feat`
commit lands as minor, `fix` as patch, `!` as major.
Anything not matching this spec is ignored by release-please, which
is exactly why the format is machine-checked.
