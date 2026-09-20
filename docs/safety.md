# Safety (write path)

## Confirmation

Confirm apply by selecting the shown target and content hash/diff. Treat cancellation, UI closure, timeout, or unrecognized input as no write. State the selected target before you ask for confirmation.

## Targets

Never auto-create `AGENTS.override.md`. Overrides alter Pi's context precedence, so leave that choice to the user. `AGENTS.override.md` beats `AGENTS.md` / `CLAUDE.md`. Treat an existing override as authoritative context. Do not overwrite it by default.

## Managed section

Keep package-managed content between `<!-- pi-init:begin -->` / `<!-- pi-init:end -->`. Preserve content outside markers byte-for-byte as user-owned. On unmarked files, append a managed section by default. Require a full diff plus unambiguous confirmation for full-file replacement. Refuse the write with a fix message when markers are malformed, duplicated, nested, reversed, or when a symlink escapes the root. Never guess a merge.

## Atomic write

Write to a same-directory temp file (restrictive permissions where supported), flush/sync, then rename atomically. Immediately before replacement, re-read the target and compare its hash to the diff base. On mismatch, abort with a rerun message. Re-read and re-validate markers after writing. Create no backup by default.

## Secrets

Screen for secrets. You will miss some. Look for private-key headers, assignment-style tokens, and credential-bearing URLs. Redact matched values in previews, logs, and model inputs. If the existing target holds a likely secret, leave it out of new content and diffs. Report the location without the value.
