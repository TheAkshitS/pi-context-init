// Deterministic Markdown renderer: same facts in → identical draft.
// Fixed rules, stable ordering, LF line endings. Omits weakly supported
// categories instead of inventing filler. Every bullet traces to evidence.
import { DEFAULT_LIMITS, type Limits } from "./config.js";
import {
  MANAGED_BEGIN,
  MANAGED_END,
  type DraftProposal,
  type InstructionTarget,
  type RepositoryFacts,
} from "./facts.js";
import { redactSecrets } from "./validate.js";

export function buildDraft(
  facts: RepositoryFacts,
  target: InstructionTarget,
  limits: Limits = DEFAULT_LIMITS,
): DraftProposal {
  const lines: string[] = ["## Managed instructions (pi-init)"];
  const bullets: string[] = [];

  if (facts.purpose) {
    bullets.push(`- Purpose: ${redactSecrets(facts.purpose.text)} (from ${facts.purpose.source}).`);
  }

  for (const toolchain of facts.toolchains) {
    bullets.push(`- Toolchain: ${toolchain.name} (evidenced by ${toolchain.evidence.join(", ")}).`);
  }

  for (const stack of facts.detectedStacks) {
    bullets.push(`- Stack: ${stack.name} (evidenced by ${stack.evidence.join(", ")}).`);
  }

  const purposeLabel = {
    test: "Test",
    lint: "Lint",
    format: "Format",
    typecheck: "Type-check",
    build: "Build",
    dev: "Dev",
  } as const;

  for (const command of facts.commands) {
    const label = purposeLabel[command.purpose] ?? command.purpose;

    bullets.push(`- ${label}: \`${redactSecrets(command.command)}\` (from ${command.source}).`);
  }

  for (const constraint of facts.constraints) {
    bullets.push(`- Requires: ${redactSecrets(constraint.text)} (from ${constraint.source}).`);
  }

  const docPaths = facts.evidence
    .filter((e) => e.kind === "docs")
    .map((e) => e.path)
    .sort()
    .slice(0, 5);

  if (docPaths.length > 0) {
    bullets.push(`- Docs: ${docPaths.join(", ")} hold contributor guidance; consult them.`);
  }

  const layered = facts.instructionFiles.filter((f) => f.scope !== "root");

  if (layered.length > 0) {
    const paths = layered
      .map((f) => f.path)
      .sort()
      .slice(0, 5)
      .join(", ");

    bullets.push(
      `- Layered instructions: ${layered.length} nested/ancestor file(s) (${paths}) also apply; keep scoped detail there.`,
    );
  }

  if (facts.limitsHit.length > 0) {
    bullets.push(
      `- Discovery was partial (${facts.limitsHit.length} limit(s) hit); re-run after narrowing scope if guidance looks thin.`,
    );
  }

  if (bullets.length === 0) {
    bullets.push(
      "- Evidence was limited (no manifests, docs, or stacks found); update this section as the project grows.",
    );
  }

  const capped = bullets.slice(0, limits.maxBullets);
  const written = fitWordBudget(capped, limits.maxDraftWords);
  const overflow = bullets.slice(written.length);

  for (const bullet of written) lines.push(bullet);

  if (overflow.length > 0) {
    lines.push(
      `- (${overflow.length} further fact(s) held for the copy-only expanded draft; choose Copy/print to view.)`,
    );
  }

  const managedBlock = `${MANAGED_BEGIN}\n${lines.join("\n")}\n${MANAGED_END}`;

  return { target, managedBlock, overflow };
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Leading bullets fitting the word budget; always keeps at least one. */
function fitWordBudget(bullets: string[], maxWords: number): string[] {
  const kept: string[] = [];
  let words = 0;

  for (const bullet of bullets) {
    const next = words + countWords(bullet);

    if (kept.length > 0 && next > maxWords) break;
    kept.push(bullet);
    words = next;
  }

  return kept;
}
