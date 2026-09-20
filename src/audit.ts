// Read-only audit and status reports. This module performs no filesystem
// writes by construction: it only reads through injected callbacks and
// returns strings. Secret values are redacted, never reproduced.
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LIMITS, type Limits } from "./config.js";
import { countWords } from "./draft.js";
import {
  MANAGED_BEGIN,
  MANAGED_END,
  type InstructionTarget,
  type RepositoryFacts,
} from "./facts.js";
import { checkMarkers } from "./merge.js";
import { renderSummary } from "./presentation.js";
import { containsLikelySecret, redactSecrets } from "./validate.js";

/** Cap on listed items per finding; reports note when more exist. */
const MAX_LISTED = 10;

/** Managed command bullets, e.g. "- Test: `npm run test` (from package.json)." */
const MANAGED_COMMAND = /^-\s*(Test|Lint|Format|Type-check|Build|Dev)\s*:\s*`([^`]+)`/;

/** Markdown links, e.g. "[guide](docs/guide.md)". */
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/** Copy-only pointer draft.ts appends after capped bullets; metadata, not a fact. */
const SYNTHETIC_OVERFLOW = /^- \(\d+ further fact/;

const KIND = {
  agentsOverride: { label: "AGENTS.override.md", rank: 0 },
  agents: { label: "AGENTS.md", rank: 1 },
  claude: { label: "CLAUDE.md", rank: 2 },
} as const;

function defaultExists(absPath: string): boolean {
  try {
    return fs.existsSync(absPath);
  } catch {
    /* v8 ignore next */
    return false;
  }
}

function bulletsOf(inner: string): string[] {
  return inner.split("\n").filter((line) => line.startsWith("- "));
}

/** Managed section body; the caller only calls this with exactly one valid marker pair. */
function managedInner(existing: string): string {
  const bi = existing.indexOf(MANAGED_BEGIN);

  return existing.slice(bi + MANAGED_BEGIN.length, existing.indexOf(MANAGED_END));
}

/** Strip one layer of wrapping punctuation/quotes/backticks/brackets. */
function bareToken(raw: string): string {
  return raw.replace(/^[`([<'"«]+/, "").replace(/[`)\]>'"».,;:!?]+$/, "");
}

/** Deterministic preference lines plus heuristic multi-file review notes. */
interface PreferenceFindings {
  det: string[];
  heu: string[];
}

/** Per-directory Pi preference (deterministic) plus multi-file review notes. */
function preferenceFindings(facts: RepositoryFacts): PreferenceFindings {
  const det: string[] = [];
  const heu: string[] = [];
  const byDir = new Map<string, typeof facts.instructionFiles>();

  for (const f of facts.instructionFiles) {
    const dir = path.dirname(f.path);
    const list = byDir.get(dir) ?? [];

    list.push(f);
    byDir.set(dir, list);
  }

  // Every key carries the list built above, so iteration needs no lookup.
  for (const [dir, list] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => KIND[a.kind].rank - KIND[b.kind].rank);
    const label = dir === "." ? "the analysis root" : dir;

    det.push(
      `Deterministic: in ${label}, Pi prefers ${KIND[list[0].kind].label} (override > AGENTS.md > CLAUDE.md).`,
    );

    if (list.length > 1) {
      heu.push(
        `Heuristic: ${label} has multiple instruction files (${list.map((f) => KIND[f.kind].label).join(", ")}); review for conflicting or duplicated guidance.`,
      );
    }
  }

  return { det, heu };
}

/** File references in the managed section that no longer resolve from the root. */
function findStaleRefs(
  root: string,
  inner: string,
  exists: (absPath: string) => boolean,
): string[] {
  const candidates = new Set<string>();

  for (const m of inner.matchAll(MARKDOWN_LINK)) {
    const href = m[2].split("#")[0].trim();

    if (href && !/^(https?:|mailto:)/i.test(href)) candidates.add(href);
  }

  for (const raw of inner.split(/\s+/)) {
    const token = bareToken(raw);

    if (!token || /[[()\]<>\s*]/.test(token) || token.includes("://")) continue;

    if (token.includes("/")) {
      if (/^[\w.@~-]+(\/[\w.@~-]+)+$/.test(token)) candidates.add(token);
    } else if (/\.(md|json|yaml|yml|toml|ini|cfg|txt|lock)$/i.test(token)) {
      candidates.add(token);
    }
  }

  return [...candidates]
    .filter((ref) => {
      const abs = path.resolve(root, ref);

      // Outside-root references are reported, never probed.
      if (path.relative(root, abs).startsWith("..")) return true;

      return !exists(abs);
    })
    .sort();
}

/** Slash-path tokens in the managed section (for package-local leakage). */
function slashTokens(inner: string): Set<string> {
  const out = new Set<string>();

  for (const raw of inner.split(/\s+/)) {
    const token = bareToken(raw);

    if (/^[\w.@~-]+(\/[\w.@~-]+)+$/.test(token)) out.add(token);
  }

  return out;
}

export function buildStatusReport(facts: RepositoryFacts, target: InstructionTarget): string {
  return redactSecrets(
    `${renderSummary(facts, target)}\n\nRead-only status: nothing was written and no files were created.`,
  );
}

export function buildAuditReport(
  facts: RepositoryFacts,
  target: InstructionTarget,
  existing: string | null,
  limits: Limits = DEFAULT_LIMITS,
  exists: (absPath: string) => boolean = defaultExists,
): string {
  const det: string[] = [];
  const heu: string[] = [];
  let needsAttention = false;

  const prefs = preferenceFindings(facts);

  det.push(...prefs.det);
  heu.push(...prefs.heu);

  if (prefs.heu.length > 0) needsAttention = true;

  let inner: string | null = null;
  let markersValid = false;

  if (existing == null) {
    det.push(
      `Deterministic: no target file yet at ${target.relPath}; a run of /init would propose creating it.`,
    );
    needsAttention = true;
  } else {
    const check = checkMarkers(existing);

    if (!check.ok) {
      det.push(`Deterministic: managed markers invalid: ${check.error}`);
      needsAttention = true;
    } else if (!existing.includes(MANAGED_BEGIN)) {
      det.push(
        "Deterministic: no managed section yet; /init would append one by default, preserving existing content.",
      );
      needsAttention = true;
    } else {
      markersValid = true;
      det.push("Deterministic: managed markers valid (exactly one begin/end pair).");
      inner = managedInner(existing);
    }

    const lines = existing.split("\n");
    const beginAt = lines.findIndex((l) => l.includes(MANAGED_BEGIN));
    const endAt = lines.findIndex((l) => l.includes(MANAGED_END));
    const secretAt: string[] = [];

    lines.forEach((line, i) => {
      if (!containsLikelySecret(line)) return;

      const where =
        beginAt >= 0 && endAt > beginAt && i > beginAt && i < endAt
          ? "managed section"
          : "user-owned region";

      secretAt.push(`line ${i + 1} (${where})`);
    });

    if (secretAt.length > 0) {
      det.push(
        `Deterministic: ${secretAt.length} likely secret value(s) in the target (${secretAt.slice(0, MAX_LISTED).join(", ")}); values redacted — remove them, and /init apply stays refused while one is present.`,
      );
      needsAttention = true;
    }
  }

  if (inner != null) {
    // Budget mirrors draft.ts: fact bullets only. The header and the
    // copy-only pointer are metadata and must not trip the budget.
    const bullets = bulletsOf(inner).filter((line) => !SYNTHETIC_OVERFLOW.test(line));
    const known = new Set(facts.commands.map((c) => c.command));
    const stale = new Set<string>();

    for (const line of inner.split("\n")) {
      const match = MANAGED_COMMAND.exec(line.trim());

      if (match && !known.has(match[2].trim())) stale.add(match[2].trim());
    }

    if (stale.size > 0) {
      const list = [...stale].sort();

      det.push(
        `Deterministic: possibly stale command(s) no longer in discovered manifests/configuration: ${list
          .slice(0, MAX_LISTED)
          .map((c) => `\`${c}\``)
          .join(", ")}${list.length > MAX_LISTED ? ` (+${list.length - MAX_LISTED} more)` : ""}.`,
      );
      needsAttention = true;
    } else if (facts.commands.length > 0) {
      det.push(
        "Deterministic: every managed command still appears in discovered manifests/configuration.",
      );
    }

    const seen = new Map<string, number>();

    for (const bullet of bullets) {
      const key = bullet.trim().replace(/\s+/g, " ").toLowerCase();

      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    const dups = [...seen.values()].filter((n) => n > 1).length;

    if (dups > 0) {
      det.push(
        `Deterministic: ${dups} duplicated bullet(s) in the managed section; keep one copy.`,
      );
      needsAttention = true;
    }

    const staleRefs = findStaleRefs(facts.root, inner, exists);

    if (staleRefs.length > 0) {
      det.push(
        `Deterministic: stale reference(s) that no longer resolve from the analysis root: ${staleRefs.slice(0, MAX_LISTED).join(", ")}${staleRefs.length > MAX_LISTED ? ` (+${staleRefs.length - MAX_LISTED} more)` : ""}.`,
      );
      needsAttention = true;
    } else {
      det.push("Deterministic: every file reference in the managed section still resolves.");
    }

    const words = bullets.reduce((sum, bullet) => sum + countWords(bullet), 0);
    const bytes = Buffer.byteLength(inner, "utf8");
    const over: string[] = [];

    if (words > limits.maxDraftWords) over.push(`${words} words (budget ${limits.maxDraftWords})`);

    if (bullets.length > limits.maxBullets)
      over.push(`${bullets.length} bullets (cap ${limits.maxBullets})`);

    if (bytes > limits.maxProposedBytes)
      over.push(`${bytes} bytes (limit ${limits.maxProposedBytes})`);

    const byCategory = new Map<string, { n: number; words: number }>();

    for (const bullet of bullets) {
      const cat = bullet.slice(2).split(":")[0].trim() || "other";
      const entry = byCategory.get(cat) ?? { n: 0, words: 0 };

      entry.n++;
      entry.words += countWords(bullet);
      byCategory.set(cat, entry);
    }

    const breakdown = [...byCategory.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([cat, entry]) => `${cat} ${entry.n} bullet(s)/~${entry.words} words`)
      .join("; ");

    if (over.length > 0) {
      det.push(
        `Deterministic: managed section exceeds the instruction budget: ${over.join(", ")}. Space by category: ${breakdown}.`,
      );
      heu.push(
        "Heuristic: the managed section is over budget; move detail to scoped docs or nested instruction files — the next /init draft holds overflow as copy-only.",
      );
      needsAttention = true;
    } else {
      det.push(
        `Deterministic: managed section within the instruction budget (~${words}/${limits.maxDraftWords} words, ${bullets.length}/${limits.maxBullets} bullets). Space by category: ${breakdown || "none"}.`,
      );
    }

    const nestedDirs = facts.instructionFiles
      .filter((f) => f.scope === "nested")
      .map((f) => path.dirname(f.path))
      .sort();

    if (nestedDirs.length > 0) {
      heu.push(
        `Heuristic: ${nestedDirs.length} nested instruction file(s) (${nestedDirs.join(", ")}) also apply; keep package-specific detail there and shared context at the root.`,
      );
    }

    const leaked = [...slashTokens(inner)]
      .filter((t) => nestedDirs.some((d) => t === d || t.startsWith(`${d}/`)))
      .sort();

    if (leaked.length > 0) {
      heu.push(
        `Heuristic: root guidance references package-local path(s) (${leaked.slice(0, MAX_LISTED).join(", ")}); prefer a package-local target so the root stays shared.`,
      );
      needsAttention = true;
    }
  }

  let actions: string;

  if (existing == null) {
    actions = "Safe next actions: run /init to draft the managed section, or do nothing.";
  } else if (!markersValid) {
    actions =
      "Safe next actions: fix the markers as described above (or delete the stray section), then rerun /init. Audit changed nothing.";
  } else if (needsAttention) {
    actions = `Safe next actions: run /init (or /init update) to refresh the managed section, or edit ${target.relPath} by hand. Audit changed nothing.`;
  } else {
    actions = "Safe next actions: no action needed.";
  }

  return redactSecrets(
    [
      renderSummary(facts, target),
      "",
      "Audit (read-only; nothing was written):",
      "Legend: Deterministic = direct check; Heuristic = judgment call, never auto-fixed.",
      "",
      ...det.map((d) => `- ${d}`),
      ...(heu.length > 0 ? ["", ...heu.map((h) => `- ${h}`)] : []),
      "",
      actions,
    ].join("\n"),
  );
}
