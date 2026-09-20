// Mode parsing and orchestration state machine. Bare /init (and the
// "update" alias) drafts and applies on approval; "audit" and "status" are
// read-only reports that never call the writer and never ask for
// confirmation. Every cancel path writes nothing.
import * as fs from "node:fs";
import { buildAuditReport, buildStatusReport } from "./audit.js";
import { DEFAULT_LIMITS } from "./config.js";
import { buildDraft } from "./draft.js";
import { inspect, type InspectOptions } from "./discover.js";
import type { InstructionTarget, RepositoryFacts } from "./facts.js";
import { buildProposal } from "./merge.js";
import { renderDiff, renderOverflow, renderProposal } from "./presentation.js";
import { selectTarget } from "./target.js";
import { applyWrite, PostWriteVerificationError, WriteConflictError } from "./transaction.js";
import { hashContent, redactSecrets, validateProposal } from "./validate.js";

export interface Choice {
  id: "apply" | "copy" | "cancel";
  label: string;
}

export const CHOICES: readonly Choice[] = [
  { id: "apply", label: "Apply" },
  { id: "copy", label: "Copy/print draft (no write)" },
  { id: "cancel", label: "Cancel (no write)" },
];

/**
 * UI surface the core needs. The Pi adapter maps this to verified
 * select/confirm/notify calls; tests inject a stub. Closing the dialog,
 * timing out, or returning an unknown option must resolve to undefined
 * and therefore to no write.
 */
export interface InteractionPort {
  show(text: string): Promise<void>;
  choose(title: string, options: readonly Choice[]): Promise<Choice | undefined>;
}

export interface RunResult {
  wrote: boolean;
  path?: string;
  message: string;
}

export interface RunOptions extends InspectOptions {
  readFile?: (absPath: string) => string | null;
}

function defaultReadFile(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch (error) {
    // SAFETY: readFileSync throws only system errors carrying `code`; anything else is rethrown.
    // A foreign throwable (throw "x") has no .message, so coerce for the UI string.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export const USAGE =
  "Usage: /init [update|audit|status]. Bare /init drafts and applies on approval; update re-runs that flow; audit and status are read-only.";

/**
 * Read-only modes: inspect, report through show(), and return. This path
 * never touches the writer, never creates temp files, and never asks for
 * confirmation, so audit/status provably change nothing.
 */
type LoadedContext =
  | { ok: true; facts: RepositoryFacts; target: InstructionTarget; existing: string | null }
  | { ok: false; message: string };

/** Shared inspect → target → (optional) read preamble. Failure messages are part of the UI contract. */
function loadContext(startDir: string, opts: RunOptions, readExisting: boolean): LoadedContext {
  let facts: RepositoryFacts;

  try {
    facts = inspect(startDir, opts);
  } catch (error) {
    // SAFETY: inspection throws only Errors; a foreign throwable still interpolates safely via String().
    /* v8 ignore next */
    return {
      ok: false,
      message: `Inspection failed: ${String((error as Error)?.message ?? error)}`,
    };
  }

  const target: InstructionTarget = selectTarget(facts);

  if (!readExisting) return { ok: true, facts, target, existing: null };

  const readFile = opts.readFile ?? defaultReadFile;

  try {
    return { ok: true, facts, target, existing: readFile(target.absPath) };
  } catch (error) {
    // SAFETY: read failures are thrown as Errors; a foreign throwable still interpolates safely via String().
    return {
      ok: false,
      message: `Cannot read target: ${String((error as Error)?.message ?? error)}`,
    };
  }
}

async function runReadOnly(
  startDir: string,
  mode: "audit" | "status",
  ui: InteractionPort,
  opts: RunOptions,
): Promise<RunResult> {
  const loaded = loadContext(startDir, opts, mode === "audit");

  if (!loaded.ok) return { wrote: false, message: loaded.message };

  const { facts, target, existing } = loaded;

  if (mode === "status") {
    await ui.show(buildStatusReport(facts, target));

    return { wrote: false, message: "Status shown above; nothing was written." };
  }

  await ui.show(buildAuditReport(facts, target, existing, opts.limits ?? DEFAULT_LIMITS));

  return { wrote: false, message: "Audit shown above; nothing was written." };
}

export async function runInit(
  startDir: string,
  rawArgs: string,
  ui: InteractionPort,
  opts: RunOptions = {},
): Promise<RunResult> {
  const arg = rawArgs.trim();

  if (arg !== "" && arg !== "update" && arg !== "audit" && arg !== "status") {
    return {
      wrote: false,
      message: `Unknown argument ${JSON.stringify(arg)}. ${USAGE}`,
    };
  }

  if (arg === "audit" || arg === "status") {
    return runReadOnly(startDir, arg, ui, opts);
  }

  const loaded = loadContext(startDir, opts, true);

  if (!loaded.ok) return { wrote: false, message: loaded.message };

  const { facts, target, existing } = loaded;
  const draft = buildDraft(facts, target, opts.limits ?? DEFAULT_LIMITS);
  const merged = buildProposal(existing, draft.managedBlock);

  if (!merged.ok) {
    return { wrote: false, message: `Cannot propose a safe update: ${merged.error}` };
  }

  const validation = validateProposal({
    root: facts.root,
    targetAbsPath: target.absPath,
    proposedContent: merged.content,
    existingContent: existing,
  });

  if (!validation.ok) {
    return { wrote: false, message: `Proposal failed validation: ${validation.errors.join(" ")}` };
  }

  const baseHash = hashContent(existing);
  await ui.show(redactSecrets(renderProposal(facts, target, renderDiff(existing, merged.content))));

  let choice: Choice | undefined;

  try {
    choice = await ui.choose(
      `Apply pi-init proposal to ${target.relPath}? (shows the diff hunk above; choose Copy/print for the full file)`,
      CHOICES,
    );
  } catch {
    choice = undefined;
  }

  if (!choice || choice.id === "cancel" || !CHOICES.some((c) => c.id === choice?.id)) {
    return { wrote: false, message: "Cancelled; nothing was written." };
  }

  if (choice.id === "copy") {
    await ui.show(
      redactSecrets(
        draft.overflow.length > 0
          ? `${merged.content}\n\n${renderOverflow(draft.overflow)}`
          : merged.content,
      ),
    );

    return { wrote: false, message: "Draft shown above; nothing was written." };
  }

  try {
    const result = applyWrite({
      targetAbsPath: target.absPath,
      proposedContent: merged.content,
      baseHash,
      root: facts.root,
    });

    return {
      wrote: true,
      path: result.path,
      message: `Wrote ${target.relPath} with one managed section.`,
    };
  } catch (error) {
    // SAFETY: WriteConflictError is handled above, so only thrown Errors remain; String() coerces safely regardless.
    if (error instanceof WriteConflictError) return { wrote: false, message: error.message };

    // SAFETY: PostWriteVerificationError means the rename already completed, so
    // the honest result is wrote:true with an inspect-before-rerun message;
    // "nothing was replaced" would be false. The disk-lying seam itself is
    // unreachable in honest tests (docs/testing.md).
    /* v8 ignore next */
    if (error instanceof PostWriteVerificationError) {
      return {
        wrote: true,
        path: target.absPath,
        message: `Wrote ${target.relPath}, but post-write verification failed: ${error.message} Inspect the file before rerunning /init.`,
      };
    }

    // SAFETY: only thrown Errors reach here; a foreign throwable still interpolates safely via String().
    return {
      wrote: false,
      message: `Write failed, nothing was replaced: ${String((error as Error)?.message ?? error)}`,
    };
  }
}
