// Domain types for pi-init. Pi-free: no Pi API imports here.
// Repository text is untrusted evidence, never instructions.

export const MANAGED_BEGIN = "<!-- pi-init:begin -->";

export const MANAGED_END = "<!-- pi-init:end -->";

/** Files pi-init may create or update. Never includes the override file. */
export const APPROVED_FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const;

export type ApprovedFilename = (typeof APPROVED_FILENAMES)[number];

/** Authoritative override: reported as context, never auto-created/overwritten. */
export const OVERRIDE_FILENAME = "AGENTS.override.md";

/** Directory names skipped by the bounded nested search; reported, never silent. */
export const EXCLUDED_DIR_NAMES: readonly string[] = [
  ".git",
  ".next",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "venv",
];

export type RootSource = "git" | "cwd";

export interface Evidence {
  path: string; // root-relative, normalized with forward slashes
  kind: string; // manifest | config | docs | instruction | git
  note: string; // factual explanation of what was detected
}

export interface DetectedStack {
  name: string;
  confidence: "high" | "medium";
  evidence: string[]; // root-relative paths
}

export interface DiscoveredCommand {
  purpose: "test" | "lint" | "format" | "typecheck" | "build" | "dev";
  command: string;
  source: string; // root-relative path the command was read from
}

export type InstructionKind = "agents" | "agentsOverride" | "claude";

export type InstructionScope = "ancestor" | "root" | "nested";

export interface InstructionFileRef {
  path: string; // root-relative
  kind: InstructionKind;
  scope: InstructionScope;
}

export interface DetectedToolchain {
  name: string;
  evidence: string[]; // root-relative paths
}

/** Repo-sourced claim kept with its provenance; redacted at render. */
export interface FactClaim {
  text: string;
  source: string; // root-relative path the text was read from
}

export interface RepositoryFacts {
  root: string; // absolute, normalized
  rootSource: RootSource;
  detectedStacks: DetectedStack[];
  toolchains: DetectedToolchain[];
  /** One-sentence project purpose from a manifest description, when present. */
  purpose: FactClaim | null;
  /** Project-wide version/tool constraints from manifests, when present. */
  constraints: FactClaim[];
  commands: DiscoveredCommand[];
  instructionFiles: InstructionFileRef[];
  evidence: Evidence[];
  limitsHit: string[];
  warnings: string[];
}

export interface InstructionTarget {
  relPath: string; // root-relative, forward slashes
  absPath: string; // absolute, normalized
  action: "create" | "update";
  note: string; // why this target was selected
  alternatives: string[]; // other files the user could choose instead
}

export interface DraftProposal {
  target: InstructionTarget;
  /** Managed block including the marker pair. */
  managedBlock: string;
  /** Bullets held back by the word/bullet budget: copy-only, never written. */
  overflow: string[];
}
