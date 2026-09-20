// Atomic, conflict-aware writer. Same-directory temp file with restrictive
// permissions, flush, atomic rename. Re-reads the target before replacing:
// on any change since the preview hash it aborts with a rerun message and
// writes nothing. Post-write re-read validates the marker structure.
// Concurrency: the hash check and rename are not locked. Concurrent writers
// race optimistically; a stale base aborts via the hash check. A change
// landing between the hash check and rename is a narrow TOCTOU window: the
// post-write check verifies disk==proposed, not lost intervening writes.
// Honest editors rerun and review fresh; this is not adversarial exclusion.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { MANAGED_BEGIN, MANAGED_END } from "./facts.js";
import { hashContent, validateProposal } from "./validate.js";

export interface WriteRequest {
  targetAbsPath: string;
  proposedContent: string;
  /** Hash of the target content at preview time (hashContent; null-origin for create). */
  baseHash: string;
  /** Analysis root for confinement rechecks; required so symlinked parents always abort. */
  root: string;
}

export interface WriteResult {
  path: string;
}

export class WriteConflictError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "Target changed since the preview. Rerun /init to review a fresh proposal; nothing was written.",
    );
    this.name = "WriteConflictError";
  }
}

/** The rename completed but the re-read disagrees with the proposal: the file on disk is NOT the approved state. */
export class PostWriteVerificationError extends Error {
  /* v8 ignore next: constructed only by the disk-lying throws in the ignored region below. */
  constructor(detail: string) {
    super(detail);
    this.name = "PostWriteVerificationError";
  }
}

function readIfExists(targetAbsPath: string): string | null {
  try {
    return fs.readFileSync(targetAbsPath, "utf8");
  } catch (error) {
    // SAFETY: readFileSync throws only system errors carrying `code`; anything else is rethrown.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function applyWrite(request: WriteRequest): WriteResult {
  const { targetAbsPath, proposedContent, baseHash, root } = request;
  const current = readIfExists(targetAbsPath);

  if (hashContent(current) !== baseHash) throw new WriteConflictError();

  // Defense in depth: re-run the full proposal validation inside the writer
  // so a future caller that skips command.ts validation still cannot write
  // secrets, oversize content, symlinks, or user-content alterations.
  // SAFETY: validateProposal takes only parsed strings and fs stats; current
  // is the just-read target content, so the existing-content input is exact.
  const recheck = validateProposal({
    root,
    targetAbsPath,
    proposedContent,
    existingContent: current,
  });

  if (!recheck.ok) {
    throw new WriteConflictError(`Proposal failed re-validation: ${recheck.errors.join(" ")}`);
  }

  const dir = path.dirname(targetAbsPath);

  const tmp = path.join(
    dir,
    `${path.basename(targetAbsPath)}.pi-init-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );

  let existingMode: number | undefined;

  try {
    // SAFETY: statSync on the just-hash-checked path reports its mode bits;
    // the bitmask keeps only permission bits for the temp-file mode below.
    existingMode = (fs.statSync(targetAbsPath).mode as number) & 0o777;
  } catch {
    existingMode = undefined;
  }

  try {
    // New files keep the restrictive 0600 default; existing files keep their
    // mode so a first apply does not flip 0644 to 0600 as a surprise.
    fs.writeFileSync(tmp, proposedContent, {
      encoding: "utf8",
      mode: existingMode ?? 0o600,
    });

    if (existingMode !== undefined) fs.chmodSync(tmp, existingMode);

    const fd = fs.openSync(tmp, "r+");

    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmp, targetAbsPath);

    // Persist the directory entry itself so a crash cannot lose the rename
    // on POSIX filesystems that only journal file data. Best-effort: a
    // platform that cannot fsync directories keeps the same durable-file
    // state as before (file synced, dir entry pending).
    // SAFETY: openSync on a directory is read-only metadata work; the fd is
    // always closed in finally and any failure is ignored, never thrown.
    try {
      const dirFd = fs.openSync(dir, "r");

      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory fsync unavailable on this platform; the file itself is synced.
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Temp already renamed or never created; nothing to clean.
    }
  }

  const written = readIfExists(targetAbsPath);

  /* v8 ignore start: post-write verification guards disk-lying; see docs/testing.md. */
  if (written !== proposedContent) {
    throw new PostWriteVerificationError("file content differs from the proposal on disk.");
  }

  if (
    written.split(MANAGED_BEGIN).length - 1 !== 1 ||
    written.split(MANAGED_END).length - 1 !== 1
  ) {
    throw new PostWriteVerificationError("managed markers are not exactly once on disk.");
  }
  /* v8 ignore stop */

  return { path: targetAbsPath };
}
