// Pi-UI-independent summary/diff strings. The selected target is always
// stated first, before any confirmation is requested.
import type { InstructionTarget, RepositoryFacts } from "./facts.js";
import { EXCLUDED_DIR_NAMES } from "./facts.js";

export const OVERFLOW_MARKER = "<!-- pi-init:overflow (copy-only, not written) -->";

/** Copy-only expanded draft: held-back facts plus the marker; never written to disk. */
export function renderOverflow(overflow: string[]): string {
  return `${OVERFLOW_MARKER}\n${overflow.join("\n")}`;
}

export function renderSummary(facts: RepositoryFacts, target: InstructionTarget): string {
  const lines: string[] = [];
  lines.push(`Target: ${target.relPath} (${target.action}). ${target.note}`);

  if (target.alternatives.length > 0) {
    lines.push(`Alternatives (not selected): ${target.alternatives.join(", ")}.`);
  }

  lines.push(
    `Analysis root: ${facts.root} (via ${facts.rootSource === "git" ? "git worktree" : "start directory"}).`,
  );

  if (facts.detectedStacks.length > 0) {
    lines.push(
      `Stacks: ${facts.detectedStacks.map((s) => `${s.name} [${s.confidence}]`).join(", ")}.`,
    );
  } else {
    lines.push("Stacks: none evidenced.");
  }

  if (facts.evidence.length > 0) {
    lines.push("Evidence:");

    for (const item of facts.evidence) lines.push(`- ${item.path} [${item.kind}]: ${item.note}`);
  } else {
    lines.push("Evidence: none found; the draft says so honestly.");
  }

  const layered = facts.instructionFiles.filter((f) => f.scope !== "root");

  if (layered.length > 0) {
    lines.push(
      `Other instruction files (untouched): ${layered.map((f) => `${f.path} [${f.scope}]`).join(", ")}.`,
    );
  }

  for (const warning of facts.warnings) lines.push(`Warning: ${warning}`);

  for (const limit of facts.limitsHit) lines.push(`Limit: ${limit}`);

  lines.push(`Skipped: ${EXCLUDED_DIR_NAMES.join(", ")} (never traversed).`);

  return lines.join("\n");
}

/** Minimal unified-style diff via common prefix/suffix; exact and stable. */
export function renderDiff(existing: string | null, proposed: string): string {
  const oldLines = existing == null ? [] : existing.split("\n");
  const newLines = proposed.split("\n");
  let prefix = 0;

  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix++;
  let suffix = 0;

  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out =
    existing == null ? ["--- (new file)", "+++ proposed"] : ["--- current", "+++ proposed"];

  const oldStart = prefix + 1;
  const newStart = prefix + 1;
  const oldCount = oldLines.length - prefix - suffix;
  const newCount = newLines.length - prefix - suffix;

  if (existing == null) {
    out.push(`@@ -0,0 +1,${newLines.length} @@ (new file: full content below)`);
  } else if (oldCount === 0 && newCount > 0) {
    out.push(`@@ -${oldStart},0 +${newStart},${newCount} @@ (pure addition)`);
  } else if (newCount === 0 && oldCount > 0) {
    out.push(`@@ -${oldStart},${oldCount} +${newStart},0 @@ (pure deletion)`);
  } else {
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
  }

  const context = (line: string): string => `  ${line}`;

  for (let i = Math.max(0, prefix - 3); i < prefix; i++) out.push(context(oldLines[i]));

  for (let i = prefix; i < oldLines.length - suffix; i++) out.push(`- ${oldLines[i]}`);

  for (let i = prefix; i < newLines.length - suffix; i++) out.push(`+ ${newLines[i]}`);

  for (
    let i = newLines.length - suffix;
    i < Math.min(newLines.length, newLines.length - suffix + 3);
    i++
  ) {
    out.push(context(newLines[i]));
  }

  return out.join("\n");
}

export function renderProposal(
  facts: RepositoryFacts,
  target: InstructionTarget,
  diff: string,
): string {
  return `${renderSummary(facts, target)}\n\n${diff}`;
}
