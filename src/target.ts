// Default target selection. Ordered policy: an existing override file is
// authoritative context and is never selected by default; AGENTS.md wins
// over CLAUDE.md; otherwise a new root AGENTS.md is proposed.
import * as path from "node:path";
import { OVERRIDE_FILENAME, type InstructionTarget, type RepositoryFacts } from "./facts.js";

export function selectTarget(facts: RepositoryFacts): InstructionTarget {
  const rootFiles = facts.instructionFiles.filter((f) => f.scope === "root");
  const has = (name: string): boolean => rootFiles.some((f) => f.path === name);
  const abs = (rel: string): string => path.resolve(facts.root, rel);

  const overrideNote =
    has(OVERRIDE_FILENAME) || facts.instructionFiles.some((f) => f.kind === "agentsOverride")
      ? " The existing AGENTS.override.md stays authoritative and is left untouched."
      : "";

  if (has("AGENTS.md")) {
    return {
      relPath: "AGENTS.md",
      absPath: abs("AGENTS.md"),
      action: "update",
      note: `Root already has AGENTS.md; updating it in place.${overrideNote}`,
      alternatives: [],
    };
  }

  if (has("CLAUDE.md")) {
    return {
      relPath: "CLAUDE.md",
      absPath: abs("CLAUDE.md"),
      action: "update",
      note: `Root has CLAUDE.md and no AGENTS.md; Pi can load CLAUDE.md, so updating it. AGENTS.md is the Pi-focused alternative.${overrideNote}`,
      alternatives: ["AGENTS.md"],
    };
  }

  return {
    relPath: "AGENTS.md",
    absPath: abs("AGENTS.md"),
    action: "create",
    note: `No root instruction file exists; creating AGENTS.md.${overrideNote}`,
    alternatives: [],
  };
}
