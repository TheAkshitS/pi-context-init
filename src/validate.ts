// Proposal, secret, and safety validation. Secret detection is a screen,
// not a guarantee. Values are redacted in previews, never reproduced.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LIMITS, type Limits } from "./config.js";
import { APPROVED_FILENAMES, MANAGED_BEGIN, MANAGED_END, OVERRIDE_FILENAME } from "./facts.js";
import { checkMarkers } from "./merge.js";
import { isWithinRoot } from "./root.js";

export interface ValidationInput {
  root: string;
  targetAbsPath: string;
  proposedContent: string;
  /** File content at preview time; null when the target did not exist. */
  existingContent: string | null;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i,
  /(api[_-]?key|secret|token|passwd|password)["']?\s*[:=]\s*\S+/i,
  /https?:\/\/[^\s/:]+:[^\s@]+@[^\s]+/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgho_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9_.~+/=-]{10,}/,
  /\bxox[bap]-[A-Za-z0-9-]{10,}/,
];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

/** Bidi overrides reorder rendered text invisibly; rejected as a safety screen. */
const BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/u;

export function redactSecrets(text: string): string {
  let out = text;

  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(
      new RegExp(pattern.source, pattern.flags.includes("i") ? "gi" : "g"),
      "[redacted]",
    );
  }

  return out;
}

export function containsLikelySecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function hashContent(content: string | null): string {
  return createHash("sha256")
    .update(content ?? "\0missing\0")
    .digest("hex");
}

export function validateProposal(
  input: ValidationInput,
  limits: Limits = DEFAULT_LIMITS,
): ValidationResult {
  const errors: string[] = [];
  const { root, targetAbsPath, proposedContent, existingContent } = input;
  const resolved = path.resolve(targetAbsPath);

  if (!isWithinRoot(root, resolved)) {
    errors.push("Target escapes the analysis root. Writes are confined to the selected root.");

    return { ok: false, errors };
  }

  const base = path.basename(resolved);

  // SAFETY: widening the const tuple to readonly string[] changes no membership; includes() needs the widened type.
  if (base === OVERRIDE_FILENAME || !(APPROVED_FILENAMES as readonly string[]).includes(base)) {
    errors.push(
      `Refusing target ${base}: only ${APPROVED_FILENAMES.join(" and ")} may be written, and never ${OVERRIDE_FILENAME} automatically.`,
    );
  }

  try {
    const parentStat = fs.lstatSync(path.dirname(resolved));

    if (!parentStat.isDirectory()) errors.push("Target parent is not a directory.");

    const realParent = fs.realpathSync(path.dirname(resolved));

    if (!isWithinRoot(root, realParent))
      errors.push("Target parent escapes the analysis root through a symlink; refusing to write.");
  } catch {
    errors.push("Target parent directory does not exist.");
  }

  try {
    if (fs.lstatSync(resolved).isSymbolicLink())
      errors.push("Target is a symlink; refusing to write through it in v1.");
  } catch {
    // Target does not exist yet: expected for create.
  }

  if (Buffer.byteLength(proposedContent, "utf8") > limits.maxProposedBytes) {
    errors.push(`Proposal exceeds the size limit (${limits.maxProposedBytes} bytes).`);
  }

  const begins = proposedContent.split(MANAGED_BEGIN).length - 1;
  const ends = proposedContent.split(MANAGED_END).length - 1;

  if (begins !== 1 || ends !== 1) {
    errors.push("Proposal must contain exactly one managed marker pair.");
  } else if (existingContent != null && checkMarkers(existingContent).ok) {
    const outside = (text: string): string => {
      if (!text.includes(MANAGED_BEGIN)) return text;
      const bi = text.indexOf(MANAGED_BEGIN);
      const ei = text.indexOf(MANAGED_END) + MANAGED_END.length;

      return text.slice(0, bi) + text.slice(ei);
    };

    const before = outside(existingContent);
    const after = outside(proposedContent);

    // Replace mode: user-owned regions must be byte-identical. Append mode
    // (existing file has no markers): only trailing separator whitespace
    // may differ; anything else is a user-content alteration.
    const preserved = existingContent.includes(MANAGED_BEGIN)
      ? after === before
      : after.startsWith(before) && after.slice(before.length).trim() === "";

    if (!preserved) {
      errors.push(
        "Proposal alters user-owned content outside the managed section; refusing the write.",
      );
    }
  }

  if (containsLikelySecret(proposedContent)) {
    errors.push(
      "Proposal contains a likely secret value; refusing to write. Remove it from the draft.",
    );
  }

  if (CONTROL_CHARS.test(proposedContent)) {
    errors.push("Proposal contains control characters or escape sequences; refusing to write.");
  }

  if (BIDI_OVERRIDES.test(proposedContent)) {
    errors.push(
      "Proposal contains invisible direction overrides; refusing to write. Remove them from the draft.",
    );
  }

  return { ok: errors.length === 0, errors };
}
