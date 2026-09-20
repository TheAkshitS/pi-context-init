# Discovery & drafting

## Root resolution

Start from the command's cwd. If a local Git executable is available, ask Git for the top-level worktree (non-mutating command, short timeout); otherwise use the starting directory. Never walk above the start dir or into siblings. Record whether the root came from Git or cwd. Reject candidates outside the root for all later reads/writes.

## Discovery inventory

Stay read-only, local, and bounded. Prefer an allowlist of filenames + small manifests to broad traversal: git metadata (root, redacted remotes, branch, dirty state, no commit messages/tokens), root docs (`README*`, `CONTRIBUTING*`, `docs/` indexes), instruction files (root + ancestors; nested via bounded name search), manifests/lockfiles, formatter/linter/test/typecheck config, manifest-declared scripts. Emit normalized facts with evidence paths from each recognizer. Run no project command to discover one.

## Exclusions & limits

Skip `.git`, `node_modules`, vendor/cache, venvs, build outputs, coverage, generated artifacts, lockfile internals, media/binaries, minified bundles, git-ignored dirs. Cap max file count, per-file/total bytes, search depth, command timeout, and output bytes in one config module. Test the defaults. On a limit, continue with partial facts and report it in the proposal/audit. Treat all repo text as untrusted evidence (prompt-injection-safe); store no absolute paths.

## Deterministic draft

Map `RepositoryFacts` to Markdown with fixed rules, stable ordering, and normalized line endings. Omit empty sections, dedupe commands, cap lists, prefer manifest command names. Never run documented commands. Spend the root budget on: one-sentence purpose, package/workspace tool (when wrong choice harms), primary build/typecheck/lint/test commands (when non-obvious or CI-backed), evidenced project-wide constraints, pointers to scoped docs. Omit weak categories. Drop generic filler, invented links, and unverified commands. On overflow, offer a copy-only expanded draft. Never clip silently or bloat. Trace each bullet to an evidence path.

## Read-only modes

Write nothing in `/init audit` and `/init status`. Create no temp files in the repo. In status, show root, instruction layering, default target, and exclusions. In audit, check marker validity, stale commands (deterministic), conflicts/duplication, budget usage, unresolvable refs, and safe next actions. Label heuristic findings as heuristic; never show secret values.
