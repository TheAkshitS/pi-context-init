// Marker parsing and non-destructive update composition. User-owned
// content outside the markers is preserved byte-for-byte. Any malformed
// marker state refuses the write with a fix message; never guess a merge.
import { MANAGED_BEGIN, MANAGED_END } from "./facts.js";

export type MergeMode = "create" | "append" | "replace";

export interface MergeOk {
  ok: true;
  mode: MergeMode;
  content: string;
}

export interface MergeErr {
  ok: false;
  error: string;
}

export type MergeResult = MergeOk | MergeErr;

/** Validate marker structure of existing file content. */
export function checkMarkers(existing: string): MergeErr | { ok: true } {
  const begins = existing.split(MANAGED_BEGIN).length - 1;
  const ends = existing.split(MANAGED_END).length - 1;

  if (begins === 0 && ends === 0) return { ok: true };

  if (begins === 0)
    return {
      ok: false,
      error:
        "End marker present without a begin marker. Delete the stray marker or restore the full managed section.",
    };

  if (ends === 0)
    return {
      ok: false,
      error:
        "Begin marker present without an end marker. Add the missing end marker or remove the section.",
    };

  if (begins > 1 || ends > 1) {
    return {
      ok: false,
      error: "Duplicated managed markers. Keep exactly one begin/end pair; remove the extras.",
    };
  }

  const bi = existing.indexOf(MANAGED_BEGIN);
  const ei = existing.indexOf(MANAGED_END);

  if (ei < bi)
    return {
      ok: false,
      error: "Markers are reversed (end before begin). Swap them into begin/end order.",
    };

  return { ok: true };
}

/**
 * Compose the proposed file content. existing === null means the target
 * does not exist yet. Returns a refusal on malformed markers.
 */
export function buildProposal(existing: string | null, managedBlock: string): MergeResult {
  if (existing == null) {
    return { ok: true, mode: "create", content: `# Project instructions\n\n${managedBlock}\n` };
  }

  const check = checkMarkers(existing);

  if (!check.ok) return check;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const block = managedBlock.split("\n").join(eol);
  const bi = existing.indexOf(MANAGED_BEGIN);

  if (bi < 0) {
    // An empty file has no user bytes to separate from the block.
    let sep: string;

    if (existing.length === 0) sep = "";
    else if (existing.endsWith("\n")) sep = eol;
    else sep = `${eol}${eol}`;

    return { ok: true, mode: "append", content: `${existing}${sep}${block}${eol}` };
  }

  const ei = existing.indexOf(MANAGED_END) + MANAGED_END.length;

  return {
    ok: true,
    mode: "replace",
    content: `${existing.slice(0, bi)}${block}${existing.slice(ei)}`,
  };
}
