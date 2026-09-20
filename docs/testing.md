# Testing and coverage

Policy: every red line is either covered by a behavior test or marked
`/* v8 ignore next */` (or a start/stop region) and listed below. No module
mocking (enforced by `anti-slop/no-module-mocking`); degradations are tested
with real temp dirs, real git repos, and stub UIs. Quality over quantity: a
seam that needs fault injection, chmod-as-root, or PATH surgery gets a
marker, not a junk test. Vitest 5 measures TypeScript source directly, so
there is no compiler-boilerplate gap.

## Commands

- `pnpm test` — full suite, no coverage (`tsc` first: the packaging tests
  assert the built `dist/` entry exists on disk).
- `pnpm coverage` — same suite with the v8 report over `src/**/*.ts`.
  Thresholds below always enforce; the command fails non-zero on any
  regression, so there is no separate check command.

Requires git present and no `PI_INIT_SKIP_GIT` — skipped git tests would
read as missing coverage. Vitest 5 needs Node 18+; the `engines` floor
is >= 24 (see `package.json`).

## Ratchet (pinned 2026-09-21, vitest 5.0.1, Node v24.21)

lines 100, statements 100, functions 100, branches 97.62. The 10
untaken arms below are the entire gap; everything else is tested or marked.
Re-pin procedure: change code, run `pnpm coverage`, update the
`thresholds` in `vitest.config.mts`, state why in the commit. Never lower
a threshold to make red go away — add a test, a marker row, or a
deleted-branch note. The 2026-09-21 re-pin covers the review fixes
(dotdot containment guard, audit budget mirroring the draft's fact
bullets, one read-budget limit per inspection, headless read-only
suffix, empty-file append, and the honest post-write result below);
all new code is tested except the marked seams. New writer hardening (required root, in-writer
re-validation, unique temp names, mode preservation, dir fsync, hunk
headers, secret/bidi screens) is pinned by `test/transaction.test.ts`,
`test/validate.test.ts`, and `test/safety-gaps.test.ts` with zero new
red lines (`transaction.ts` now 100/100/100/100).

Untaken arms, all absorbed (none testable without mocking, fault
injection, or platform luck):

- `extension.ts` headless notify level: headless runs never write by
  design, so the `"info"` arm never fires. The same ternary on the
  interactive path is covered both ways.
- `extension.ts` empty-message guard and `root.ts` empty-top guard:
  `runInit` always returns a message; git never prints an empty toplevel
  with status 0.
- Taken-edges of ignored regions (8× `if@undefined`): the catch-taken side
  of each marked catch below, plus the `command.ts`
  `PostWriteVerificationError` instanceof (the rename completed, so its
  arm reports `wrote:true` with an inspect-before-rerun message — the one
  write-path result that is not a clean apply). Excluding them would
  require start/stop regions that also hide the tested try bodies, so they
  stay visible.
- Loop-exit and short-circuit combos (`renderDiff` prefix/suffix bounds,
  brace-scanner char classes, `arg !== ...` chains, `||`/`&&` guards):
  combinatorial; pinning each would need junk tests.

## Untestable-by-design seams (all marked in src)

| Seam | Why no honest test reaches it |
| --- | --- |
| `spawnSync` throw catches (`root.ts`, `discover.ts` runGit) | Fire only when git is missing; PATH surgery is flaky by design. Nonzero-exit and non-repo paths are tested, including an unresolvable-cwd fallback test. |
| `audit.ts` defaultExists catch | `existsSync` throws only on off-type input, never on missing files. |
| `command.ts` loadContext inspect catch | Every inner call guards its I/O; fails only on off-type `startDir`. Pi always passes a cwd string. |
| `transaction.ts` post-write region (start/stop) | Fires only if the disk changes content between rename and re-read. Deliberately duplicates pre-write validation (defense in depth for a writer). Throws `PostWriteVerificationError`; `command.ts` maps it to `wrote:true` plus an inspect-before-rerun message. |
| `discover.ts` readManifest stat catch, read catch | TOCTOU races (deleted/unreadable between stat and read); `utf8` decode never throws for bad bytes. Common paths tested via tiny-limit fixtures. |
| `discover.ts` stat/readdir `continue`s (root scan, second pass, nested walk) | Filesystem races or chmod-gated dirs; chmod is flaky as root. |
| `discover.ts` extractObjectBlock trailing null | Valid-JSON manifests always balance, so the hand scan always resolves; safety net for adversarial input (all repository text is untrusted). |
| `discover.ts` idempotency/contract guards (`addCommand` dedup, `toRelPath` null, `!rel`, filesystem-root break) | Single-pass collection with inside-paths only; the arms are unreachable by construction. kept as stated invariants, not tested. |

## Deleted, not ignored

- `discover.ts` filename→kind ternaries ×3: folded into one `kindOf` helper, plus a dead `stat.isFile()` refinement and hoisted `stringPairs`/`bulletsOf` scans. The dedup deleted 9 covered arms (denominator 444→435); the two newly-coverable pyproject-absent arms are pinned by the minimal-pyproject test.
- `merge.ts` nested-marker check: unreachable by counting (one begin plus
  one end leaves no room for a nested pair; the duplicated-marker arm
  reports it first).
- `discover.ts` queue-shift guard: index loop instead (also kills the O(n)
  shift); no empty-queue case remains.
- `discover.ts` readManifest per-file cap: dead since the second pass
  pre-filters oversized manifests; the reporting branch there is tested.
- `discover.ts` first pass missing `isFile`: a directory named
  `package.json` claimed a stack. Now skipped like the second pass; a
  regression test pins it.
- `audit.ts` managed-section re-check and directory-lookup fallback:
  provably redundant at their single call sites (`markersValid` implies
  the pair; the map is populated just above).
- `root.ts` / `discover.ts` `?? ""` on spawnSync stdout: typed `string`
  via the utf8 encoding; the fallback was unreachable.
- `validate.ts` symlink-parent arm: `lstat` never reports a symlink as a
  directory, so the first arm always catches it (plus the realpath escape
  check, which is tested).
- `extension.ts` headless `choose` guard: `handleInit` never invokes
  `choose` without a UI (separate closure); the try/catch backstop remains.

## Tool quirks (also red, also not ours)

- Ignore directives report themselves as uncovered lines; closing braces
  of ignored blocks do too.
- `throw` statements are not excludable by `ignore next` (hence the
  start/stop region in `transaction.ts`).

## What coverage can't see (manual matrix)

- Packed-tarball copies are outside `include`, so they never dilute the
  numbers; their *behavior* is still asserted by `packaging.test.ts`
  (cancel/apply/audit end to end).
- Real-TUI wiring runs the dialog matrix through the real `pi` binary over
  RPC (`test/tui-apply.test.ts`): register → prompt → answer the real
  select dialog. Covered: Apply writes one section; Cancel, Copy/print,
  dismissal, and forged answers write nothing; audit/status never open a
  dialog; unknown args explain usage without a dialog; `/init update`
  re-drafts after a manifest change and Apply writes it. Adapter unit tests
  plus the `pi.registerCommand` fail-closed test pin the seams. Pi API
  drift is fenced by `docs/pi-api-notes.md`. Skipped with
  `PI_INIT_SKIP_RPC=1` or when no `pi` binary is on PATH.
- `PI_INIT_SKIP_GIT=1` runs skip git-backed tests; the gate must run
  without it.
