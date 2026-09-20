// Root resolution and path containment. Never walks above the start
// directory as a fallback and never inspects siblings.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Limits } from "./config.js";
import { DEFAULT_LIMITS } from "./config.js";

export interface ResolvedRoot {
  root: string;
  rootSource: "git" | "cwd";
}

/** Runs `git rev-parse --show-toplevel` in cwd; null when unavailable. */
export function defaultGitTopLevel(cwd: string, limits: Limits = DEFAULT_LIMITS): string | null {
  try {
    const out = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: limits.gitTimeoutMs,
      maxBuffer: limits.maxOutputBytes,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (out.error || out.status !== 0) return null;
    const top = String(out.stdout).trim();

    return top.length > 0 ? top : null;
  } catch {
    /* v8 ignore next */
    return null;
  }
}

/** Canonicalize for comparison (resolves symlinks such as macOS /var). */
export function canonical(candidatePath: string): string {
  try {
    return fs.realpathSync(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

/**
 * Resolve the analysis root from a start directory. Uses the git worktree
 * top level when the start directory is inside one, otherwise the start
 * directory itself. The candidate must contain the start directory;
 * anything else falls back to the start directory.
 */
export function resolveRoot(
  startDir: string,
  gitTopLevel: (cwd: string) => string | null = (cwd) => defaultGitTopLevel(cwd),
): ResolvedRoot {
  const start = canonical(startDir);
  let candidate: string | null = null;

  try {
    candidate = gitTopLevel(start);
  } catch {
    candidate = null;
  }

  if (candidate) {
    const root = canonical(candidate);

    if (isWithinRoot(root, start)) return { root, rootSource: "git" };
  }

  return { root: start, rootSource: "cwd" };
}

/** True when candidate resolves to root or something inside it. */
export function isWithinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));

  // Only an exact ".." or a "../" prefix escapes; a sibling named "..foo" does not.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
