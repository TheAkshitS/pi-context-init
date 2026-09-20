// Bounded, read-only repository inspection. Local only, no subprocesses
// except the git metadata reads (short timeout, output-capped, cwd-bound).
// All repository text is untrusted evidence, never instructions.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LIMITS, type Limits } from "./config.js";
import {
  EXCLUDED_DIR_NAMES,
  OVERRIDE_FILENAME,
  type InstructionKind,
  type RepositoryFacts,
} from "./facts.js";
import { resolveRoot, canonical } from "./root.js";

const EXCLUDED_DIRS = new Set<string>(EXCLUDED_DIR_NAMES);

const ROOT_DOC_PREFIXES = ["README", "CONTRIBUTING", "DEVELOPMENT", "ARCHITECTURE"];

const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md", OVERRIDE_FILENAME];

/** Filename to instruction kind; callers only pass names from INSTRUCTION_NAMES. */
function kindOf(name: string): InstructionKind {
  if (name === OVERRIDE_FILENAME) return "agentsOverride";

  if (name === "AGENTS.md") return "agents";

  return "claude";
}

const MANIFEST_STACKS: Array<{ file: string; stack: string; confidence: "high" | "medium" }> = [
  { file: "package.json", stack: "node", confidence: "high" },
  { file: "pyproject.toml", stack: "python", confidence: "high" },
  { file: "Cargo.toml", stack: "rust", confidence: "high" },
  { file: "go.mod", stack: "go", confidence: "high" },
  { file: "pom.xml", stack: "java", confidence: "medium" },
  { file: "Gemfile", stack: "ruby", confidence: "medium" },
];

const LOCKFILE_TOOLCHAINS: Array<{ file: string; toolchain: string }> = [
  { file: "pnpm-lock.yaml", toolchain: "pnpm" },
  { file: "package-lock.json", toolchain: "npm" },
  { file: "yarn.lock", toolchain: "yarn" },
  { file: "bun.lock", toolchain: "bun" },
  { file: "bun.lockb", toolchain: "bun" },
];

/** Script names evidencing each purpose, in preference order. */
const SCRIPT_PURPOSES: Array<{
  purpose: "test" | "lint" | "format" | "typecheck" | "build" | "dev";
  names: string[];
}> = [
  { purpose: "test", names: ["test"] },
  { purpose: "lint", names: ["lint"] },
  { purpose: "format", names: ["format"] },
  { purpose: "typecheck", names: ["typecheck", "type-check"] },
  { purpose: "build", names: ["build"] },
  { purpose: "dev", names: ["dev", "start"] },
];

const PURPOSE_ORDER = ["test", "lint", "format", "typecheck", "build", "dev"];

/** Bounded UTF-8 read of a manifest; null when skipped, with the skip reported. */
function readManifest(
  facts: RepositoryFacts,
  rel: string,
  abs: string,
  limits: Limits,
  budget: { used: number; over?: boolean },
): string | null {
  let stat: fs.Stats;

  try {
    stat = fs.statSync(abs);
  } catch {
    /* v8 ignore next */
    return null;
  }

  budget.used += stat.size;

  if (budget.used > limits.maxTotalBytes) {
    // Reported once for the first file that trips; later skips are silent to
    // keep the limits-hit count one per condition.
    if (budget.over !== true) {
      budget.over = true;
      facts.limitsHit.push(
        `Total manifest bytes exceed the read budget (${limits.maxTotalBytes}); ${rel} and later files skipped.`,
      );
    }

    return null;
  }

  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    /* v8 ignore next */
    facts.warnings.push(`${rel} could not be read as UTF-8; skipped.`);

    /* v8 ignore next */
    return null;
  }
}

function runGit(args: string[], cwd: string, limits: Limits): string | null {
  try {
    const out = spawnSync("git", args, {
      cwd,
      timeout: limits.gitTimeoutMs,
      maxBuffer: limits.maxOutputBytes,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (out.error || out.status !== 0) return null;

    return String(out.stdout).slice(0, limits.maxOutputBytes);
  } catch {
    /* v8 ignore next */
    return null;
  }
}

/** Record a toolchain once, merging evidence paths deterministically. */
function addToolchain(facts: RepositoryFacts, name: string, rel: string): void {
  const found = facts.toolchains.find((t) => t.name === name);

  if (found) {
    if (!found.evidence.includes(rel)) found.evidence.push(rel);

    return;
  }

  facts.toolchains.push({ name, evidence: [rel] });
}

/** Purpose-ordered insertion for stable, deterministic command lists. */
function addCommand(
  facts: RepositoryFacts,
  purpose: "test" | "lint" | "format" | "typecheck" | "build" | "dev",
  command: string,
  source: string,
): void {
  /* v8 ignore next: dedup guard for the deterministic-draft contract; unreachable single-pass. */
  if (facts.commands.some((c) => c.purpose === purpose && c.command === command)) return;
  facts.commands.push({ purpose, command, source });
}

/** Preferred node runner: evidenced toolchain, else npm (ships with node). */
function nodeRunner(facts: RepositoryFacts): string {
  const pm = facts.toolchains.find((t) => ["pnpm", "npm", "yarn", "bun"].includes(t.name));

  return pm ? pm.name : "npm";
}

/** Manifest-content facts: scripts, descriptions, constraints. Untrusted input, stored with provenance. */
function collectManifestDetails(
  facts: RepositoryFacts,
  rel: string,
  abs: string,
  limits: Limits,
  budget: { used: number },
): void {
  if (rel === "package.json") return collectPackageJson(facts, rel, abs, limits, budget);

  if (rel === "Cargo.toml") return collectCargoToml(facts, rel, abs, limits, budget);

  if (rel === "go.mod") {
    addCommand(facts, "test", "go test ./...", rel);
    addCommand(facts, "build", "go build ./...", rel);

    return;
  }

  if (rel === "pyproject.toml") return collectPyproject(facts, rel, abs, limits, budget);
}

/** First line of text, trimmed and capped. Manifest text stays text: never parsed into objects. */
function firstLine(text: string, maxChars: number): string {
  const head = text.split(/\r?\n/)[0];

  return head.trim().slice(0, maxChars);
}

/** Balanced-brace object block for a top-level `"key": {...}` pair, or null. */
function extractObjectBlock(content: string, key: string): string | null {
  const open = content.match(new RegExp(`"${key}"\\s*:\\s*\\{`, "m"));

  if (!open || open.index == null) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const start = open.index + open[0].length - 1;

  for (let i = start; i < content.length; i++) {
    const ch = content[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;

      if (depth === 0) return content.slice(start + 1, i);
    }
  }

  /* v8 ignore next */
  return null;
}

/** `"name": "value"` string pairs inside an object block, in file order. */
function stringPairs(block: string): Array<{ name: string; value: string }> {
  const pairs: Array<{ name: string; value: string }> = [];
  const pattern = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match = pattern.exec(block);

  while (match) {
    pairs.push({ name: match[1], value: match[2] });
    match = pattern.exec(block);
  }

  return pairs;
}

function collectPackageJson(
  facts: RepositoryFacts,
  rel: string,
  abs: string,
  limits: Limits,
  budget: { used: number },
): void {
  const content = readManifest(facts, rel, abs, limits, budget);

  if (content == null) return;

  try {
    JSON.parse(content);
  } catch {
    facts.warnings.push(`${rel} is not valid JSON; skipping script analysis.`);

    return;
  }

  const pairs = stringPairs(content);
  const pmField = pairs.find((p) => p.name === "packageManager")?.value;

  if (pmField) {
    const pmName = pmField.split("@")[0].trim();

    if (pmName) addToolchain(facts, pmName, rel);
  }

  const description = firstLine(pairs.find((p) => p.name === "description")?.value ?? "", 200);

  if (description && !facts.purpose) facts.purpose = { text: description, source: rel };

  const enginesBlock = extractObjectBlock(content, "engines");

  if (enginesBlock) {
    const seen = new Set<string>();

    for (const { name, value } of stringPairs(enginesBlock)) {
      const range = value.trim();

      if (range && !seen.has(name)) {
        seen.add(name);
        facts.constraints.push({ text: `${name} ${range}`.slice(0, 120), source: rel });
      }
    }

    facts.constraints.sort((a, b) => a.text.localeCompare(b.text));
  }

  const scriptsBlock = extractObjectBlock(content, "scripts");
  const runner = nodeRunner(facts);

  if (scriptsBlock) {
    const scripts = new Set(
      stringPairs(scriptsBlock)
        .filter((p) => p.value.trim().length > 0)
        .map((p) => p.name),
    );

    for (const { purpose, names } of SCRIPT_PURPOSES) {
      const hit = names.find((name) => scripts.has(name));

      if (hit) addCommand(facts, purpose, `${runner} run ${hit}`, rel);
    }
  }
}

function collectCargoToml(
  facts: RepositoryFacts,
  rel: string,
  abs: string,
  limits: Limits,
  budget: { used: number },
): void {
  const content = readManifest(facts, rel, abs, limits, budget);

  if (content == null) return;
  const description = content.match(/^description\s*=\s*"([^"]+)"/m)?.[1]?.trim();

  if (description && !facts.purpose) {
    facts.purpose = { text: firstLine(description, 200), source: rel };
  }

  const rustVersion = content.match(/^rust-version\s*=\s*"([^"]+)"/m)?.[1]?.trim();

  if (rustVersion) {
    facts.constraints.push({ text: `rust ${rustVersion}`.slice(0, 120), source: rel });
  }

  addCommand(facts, "test", "cargo test", rel);
  addCommand(facts, "build", "cargo build", rel);
}

function collectPyproject(
  facts: RepositoryFacts,
  rel: string,
  abs: string,
  limits: Limits,
  budget: { used: number },
): void {
  const content = readManifest(facts, rel, abs, limits, budget);

  if (content == null) return;
  const description = content.match(/^description\s*=\s*"([^"]+)"/m)?.[1]?.trim();

  if (description && !facts.purpose) {
    facts.purpose = { text: firstLine(description, 200), source: rel };
  }

  const requiresPython = content.match(/^requires-python\s*=\s*"([^"]+)"/m)?.[1]?.trim();

  if (requiresPython) {
    facts.constraints.push({ text: `python ${requiresPython}`.slice(0, 120), source: rel });
  }

  if (/\[tool\.pytest\.ini_options\]/m.test(content)) addCommand(facts, "test", "pytest", rel);

  if (/\[tool\.ruff\]/m.test(content)) addCommand(facts, "lint", "ruff check", rel);
}

/** Root-relative forward-slash path, or null when outside the root. */
export function toRelPath(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);

  /* v8 ignore next: total-function guard; callers only pass inside-paths (posix: never absolute). */
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;

  return rel.split(path.sep).join("/");
}

export interface InspectOptions {
  limits?: Limits;
  gitTopLevel?: (cwd: string) => string | null;
}

export function inspect(startDir: string, opts: InspectOptions = {}): RepositoryFacts {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const { root, rootSource } = resolveRoot(startDir, opts.gitTopLevel);

  const facts: RepositoryFacts = {
    root,
    rootSource,
    detectedStacks: [],
    toolchains: [],
    purpose: null,
    constraints: [],
    commands: [],
    instructionFiles: [],
    evidence: [],
    limitsHit: [],
    warnings: [],
  };

  collectGitFacts(facts, startDir, limits);
  collectRootFiles(facts, limits);
  collectAncestors(facts, canonical(startDir));
  collectNested(facts, limits);

  // Sorted once here: order during collection is discovery order.
  facts.toolchains.sort((a, b) => a.name.localeCompare(b.name));
  facts.commands.sort(
    (a, b) => PURPOSE_ORDER.indexOf(a.purpose) - PURPOSE_ORDER.indexOf(b.purpose),
  );

  if (facts.evidence.length === 0) {
    facts.warnings.push(
      "Evidence is limited: no manifests, docs, or instruction files found at the analysis root.",
    );
  }

  return facts;
}

function collectGitFacts(facts: RepositoryFacts, startDir: string, limits: Limits): void {
  if (facts.rootSource !== "git") {
    facts.warnings.push(
      "Not inside a git worktree; using the start directory as the analysis root.",
    );

    return;
  }

  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], startDir, limits)?.trim();
  const status = runGit(["status", "--porcelain"], startDir, limits);
  const remotes = runGit(["remote", "-v"], startDir, limits);
  const parts: string[] = [];

  if (branch) parts.push(`branch ${branch}`);

  if (status != null) parts.push(status.trim().length > 0 ? "worktree dirty" : "worktree clean");

  if (remotes) {
    const hosts = new Set<string>();

    for (const m of remotes.matchAll(/[@/]([A-Za-z0-9.-]+)(?::\d+)?[:/]/g)) hosts.add(m[1]);

    if (hosts.size > 0) parts.push(`remotes: ${[...hosts].sort().join(", ")}`);
  }

  facts.evidence.push({
    path: ".",
    kind: "git",
    note: parts.length > 0 ? `Git worktree (${parts.join("; ")}).` : "Git worktree.",
  });

  if (branch == null && status == null) {
    facts.warnings.push("Git metadata unreadable; continuing without it.");
  }
}

function collectRootFiles(facts: RepositoryFacts, limits: Limits): void {
  let entries: string[];
  const budget = { used: 0 };

  try {
    entries = fs.readdirSync(facts.root);
  } catch {
    facts.warnings.push("Analysis root is unreadable; continuing with no file evidence.");

    return;
  }

  for (const entry of entries.sort()) {
    const abs = path.join(facts.root, entry);
    let stat: fs.Stats;

    try {
      stat = fs.statSync(abs);
    } catch {
      /* v8 ignore next */
      continue;
    }

    if (!stat.isFile()) continue;
    const rel = toRelPath(facts.root, abs);

    /* v8 ignore next: readdir only yields inside-paths; see above. */
    if (!rel) continue;

    if (INSTRUCTION_NAMES.includes(entry)) {
      facts.instructionFiles.push({ path: rel, kind: kindOf(entry), scope: "root" });
      facts.evidence.push({
        path: rel,
        kind: "instruction",
        note: `Existing instruction file (${stat.size} bytes).`,
      });
      continue;
    }

    if (ROOT_DOC_PREFIXES.some((p) => entry === p || entry.startsWith(`${p}.`))) {
      facts.evidence.push({
        path: rel,
        kind: "docs",
        note: `Root documentation (${stat.size} bytes).`,
      });
      continue;
    }

    const lockfile = LOCKFILE_TOOLCHAINS.find((l) => l.file === entry);

    if (lockfile) {
      addToolchain(facts, lockfile.toolchain, rel);
      facts.evidence.push({
        path: rel,
        kind: "manifest",
        note: `Lockfile evidencing ${lockfile.toolchain}.`,
      });
      continue;
    }

    const manifest = MANIFEST_STACKS.find((m) => m.file === entry);

    if (manifest && stat.size <= limits.maxFileBytes) {
      facts.detectedStacks.push({
        name: manifest.stack,
        confidence: manifest.confidence,
        evidence: [rel],
      });
      facts.evidence.push({
        path: rel,
        kind: "manifest",
        note: `Manifest evidencing ${manifest.stack}.`,
      });
    }
  }

  // Second pass: manifest contents, after all lockfiles registered their toolchains.
  for (const manifest of MANIFEST_STACKS) {
    const abs = path.join(facts.root, manifest.file);
    let stat: fs.Stats;

    try {
      stat = fs.statSync(abs);
    } catch {
      /* v8 ignore next */
      continue;
    }

    if (!stat.isFile()) continue;

    if (stat.size > limits.maxFileBytes) {
      facts.limitsHit.push(
        `${manifest.file} (${stat.size} bytes) exceeds the per-file read cap; skipped.`,
      );

      continue;
    }

    collectManifestDetails(facts, manifest.file, abs, limits, budget);
  }

  facts.detectedStacks.sort((a, b) => a.name.localeCompare(b.name));
}

/** Instruction files on the path from the start directory up to the root. */
function collectAncestors(facts: RepositoryFacts, startDir: string): void {
  let dir = path.resolve(startDir);
  const seen = new Set(facts.instructionFiles.map((f) => f.path));

  while (true) {
    for (const name of INSTRUCTION_NAMES) {
      const abs = path.join(dir, name);
      let stat: fs.Stats;

      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }

      if (!stat.isFile()) continue;
      const rel = toRelPath(facts.root, abs);

      if (!rel || seen.has(rel)) continue;
      seen.add(rel);

      // Root files are pre-seen from collectRootFiles, so this walk only yields ancestors.
      const scope = "ancestor";

      facts.instructionFiles.push({ path: rel, kind: kindOf(name), scope });
    }

    if (dir === facts.root) break;
    const parent = path.dirname(dir);

    /* v8 ignore next: termination guard; the root break above always fires first. */
    if (parent === dir) break;
    dir = parent;
  }
}

/** Bounded name search for nested instruction files; honors exclusions. */
function collectNested(facts: RepositoryFacts, limits: Limits): void {
  const seen = new Set(facts.instructionFiles.map((f) => f.path));
  const queue: Array<{ dir: string; depth: number }> = [{ dir: facts.root, depth: 0 }];
  let visited = 0;

  // Index loop, not shift: entries are only appended below, so the head
  // chasing the tail visits every directory once with no empty-queue case.
  for (let head = 0; head < queue.length; head++) {
    const next = queue[head];

    if (next.depth >= limits.maxDepth) continue;
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(next.dir, { withFileTypes: true });
    } catch {
      /* v8 ignore next */
      continue;
    }

    for (const entry of entries) {
      visited++;

      if (visited > limits.maxFiles) {
        facts.limitsHit.push(
          `maxFiles (${limits.maxFiles}) reached during nested search; results are partial.`,
        );

        return;
      }

      const abs = path.join(next.dir, entry.name);

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        queue.push({ dir: abs, depth: next.depth + 1 });
      } else if (entry.isFile() && INSTRUCTION_NAMES.includes(entry.name)) {
        const rel = toRelPath(facts.root, abs);

        if (!rel || seen.has(rel)) continue;
        seen.add(rel);
        facts.instructionFiles.push({ path: rel, kind: kindOf(entry.name), scope: "nested" });
      }
    }
  }
}
