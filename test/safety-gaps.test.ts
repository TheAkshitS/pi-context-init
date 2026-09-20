// Behavior-gap coverage: refusals, degradation paths, and adapter failures.
// Each test pins user-visible behavior. Seams that no honest test can reach are
// marked /* v8 ignore next */ in src and catalogued in docs/testing.md.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { buildAuditReport } from "../src/audit.js";
import initExtension, { handleInit } from "../src/extension.js";
import { CHOICES, runInit, type Choice, type InteractionPort } from "../src/command.js";
import { DEFAULT_LIMITS } from "../src/config.js";
import { inspect } from "../src/discover.js";
import { buildDraft } from "../src/draft.js";
import { MANAGED_BEGIN, MANAGED_END, type DiscoveredCommand } from "../src/facts.js";
import { buildProposal } from "../src/merge.js";
import { renderDiff, renderOverflow } from "../src/presentation.js";
import { resolveRoot } from "../src/root.js";
import { selectTarget } from "../src/target.js";
import { applyWrite } from "../src/transaction.js";
import { hashContent, validateProposal } from "../src/validate.js";

function mkTemp(prefix = "pi-init-gaps-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const BLOCK = `${MANAGED_BEGIN}\n## Managed instructions (pi-init)\n- A fact.\n${MANAGED_END}`;

const PROPOSED = `# Project instructions\n\n${BLOCK}\n`;

const APPLY = CHOICES[0];

const COPY = CHOICES[1];

const NO_GIT = { gitTopLevel: () => null };

function silentUi(choice: Choice | undefined): InteractionPort {
  return { show: async () => {}, choose: async () => choice };
}

// --- validateProposal: confinement and filename allowlist ---

test("validate refuses targets outside the root and non-approved names", () => {
  const root = fs.realpathSync(mkTemp());

  for (const target of [
    path.join(root, "..", "AGENTS.md"),
    path.join(root, "AGENTS.override.md"),
    path.join(root, "NOTES.md"),
  ]) {
    const result = validateProposal({
      root,
      targetAbsPath: target,
      proposedContent: PROPOSED,
      existingContent: null,
    });

    expect(result.ok, target).toBe(false);
  }

  expect(validateProposal({
      root,
      targetAbsPath: path.join(root, "AGENTS.md"),
      proposedContent: PROPOSED,
      existingContent: null,
    }).ok).toBe(true);
});

test("validate refuses missing parents, oversize proposals, and bad markers", () => {
  const root = fs.realpathSync(mkTemp());

  expect(validateProposal({
      root,
      targetAbsPath: path.join(root, "nope", "AGENTS.md"),
      proposedContent: PROPOSED,
      existingContent: null,
    }).errors.join(" ")).toMatch(/parent directory does not exist/);

  expect(validateProposal(
      {
        root,
        targetAbsPath: path.join(root, "AGENTS.md"),
        proposedContent: PROPOSED,
        existingContent: null,
      },
      { ...DEFAULT_LIMITS, maxProposedBytes: 10 },
    ).errors.join(" ")).toMatch(/size limit/);

  expect(validateProposal({
      root,
      targetAbsPath: path.join(root, "AGENTS.md"),
      proposedContent: "# Manual\n",
      existingContent: null,
    }).errors.join(" ")).toMatch(/exactly one managed marker/);
});

test("validate refuses secrets and control characters", () => {
  const root = fs.realpathSync(mkTemp());
  const target = path.join(root, "AGENTS.md");

  expect(validateProposal({
      root,
      targetAbsPath: target,
      proposedContent: `${BLOCK}\napi_key = hunter2-value\n`,
      existingContent: null,
    }).errors.join(" ")).toMatch(/secret/);

  expect(validateProposal({
      root,
      targetAbsPath: target,
      proposedContent: `${PROPOSED}`,
      existingContent: null,
    }).errors.join(" ")).toMatch(/control characters/);
});

// --- command error paths: read failure and UI closure write nothing ---

test("unreadable target and throwing UI resolve to no write", async () => {
  const dir = mkTemp();
  write(dir, "AGENTS.md", "# Owner\n");

  const unreadable = await runInit(dir, "", silentUi(APPLY), {
    ...NO_GIT,
    readFile: () => {
      throw new Error("EACCES");
    },
  });

  expect(unreadable.wrote).toBe(false);
  expect(unreadable.message).toMatch(/Cannot read target/);

  const throwingUi: InteractionPort = {
    show: async () => {},
    choose: async () => {
      throw new Error("dialog closed");
    },
  };

  const closed = await runInit(dir, "", throwingUi, NO_GIT);
  expect(closed.wrote).toBe(false);
  expect(closed.message).toMatch(/Cancelled/);
  expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("# Owner\n");
});

// --- audit: missing file, same-dir conflict, duplicates, budget ---

test("audit on a missing target proposes creation and writes nothing", async () => {
  const dir = mkTemp();
  const shown: string[] = [];

  const result = await runInit(
    dir,
    "audit",
    { show: async (t) => void shown.push(t), choose: async () => undefined },
    NO_GIT,
  );

  expect(result.wrote).toBe(false);
  expect(shown.join("\n")).toMatch(/no target file yet/);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test("audit flags same-directory instruction conflicts and duplicate bullets", async () => {
  const dir = mkTemp();
  write(dir, "AGENTS.md", `# Owner\n\n${BLOCK}\n`);
  write(dir, "CLAUDE.md", "# Alt\n");
  const before = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  const duped = before.replace("- A fact.", "- A fact.\n- A fact.");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), duped);

  const shown: string[] = [];
  await runInit(
    dir,
    "audit",
    { show: async (t) => void shown.push(t), choose: async () => undefined },
    NO_GIT,
  );
  const out = shown.join("\n");
  expect(out).toMatch(/multiple instruction files/);
  expect(out).toMatch(/duplicated bullet/);
  expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(duped);
});

test("audit flags over-budget managed sections without writing", async () => {
  const dir = mkTemp();
  write(dir, "AGENTS.md", `# Owner\n\n${BLOCK}\n`);
  const shown: string[] = [];
  await runInit(
    dir,
    "audit",
    { show: async (t) => void shown.push(t), choose: async () => undefined },
    { ...NO_GIT, limits: { ...DEFAULT_LIMITS, maxDraftWords: 1, maxBullets: 1 } },
  );
  expect(shown.join("\n")).toMatch(/exceeds the instruction budget/);
});

// --- draft: layering, limits, and copy-only overflow ---

test("draft names layered files and partial discovery; copy shows overflow", async () => {
  const dir = mkTemp();
  write(dir, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }));
  write(dir, "packages/app/AGENTS.md", "# App\n");

  const facts = inspect(dir, NO_GIT);
  const draft = buildDraft(facts, selectTarget(facts));
  expect(draft.managedBlock).toMatch(/Layered instructions/);

  const partial = buildDraft(
    { ...facts, limitsHit: ["maxFiles reached"] },
    selectTarget(facts),
  );

  expect(partial.managedBlock).toMatch(/Discovery was partial/);

  const tiny = buildDraft(facts, selectTarget(facts), { ...DEFAULT_LIMITS, maxDraftWords: 1 });
  expect(tiny.overflow.length > 0).toBeTruthy();
  expect(renderOverflow(tiny.overflow)).toMatch(/overflow \(copy-only, not written\)/);

  const shown: string[] = [];

  const result = await runInit(
    dir,
    "",
    { show: async (t) => void shown.push(t), choose: async () => COPY },
    { ...NO_GIT, limits: { ...DEFAULT_LIMITS, maxDraftWords: 1 } },
  );

  expect(result.wrote).toBe(false);
  expect(shown.join("\n")).toMatch(/overflow \(copy-only, not written\)/);
  expect(fs.readdirSync(dir).sort(), "copy path writes nothing").toEqual(["package.json", "packages"].sort());
});

// --- discover: invalid JSON, caps, go stack, packageManager toolchain ---

test("discover warns on invalid JSON, honors caps, and merges toolchain evidence", () => {
  const bad = mkTemp();
  write(bad, "package.json", "{ not json");
  const badFacts = inspect(bad, NO_GIT);
  expect(badFacts.warnings.some((w) => /not valid JSON/.test(w))).toBeTruthy();
  expect(badFacts.commands).toEqual([]);

  const capped = mkTemp();
  write(capped, "package.json", JSON.stringify({ name: "x", scripts: { test: "vitest run" } }));

  const tiny = inspect(capped, {
    ...NO_GIT,
    limits: { ...DEFAULT_LIMITS, maxFileBytes: 10 },
  });

  expect(tiny.limitsHit.some((l) => /per-file read cap/.test(l))).toBeTruthy();

  const budgeted = inspect(capped, {
    ...NO_GIT,
    limits: { ...DEFAULT_LIMITS, maxTotalBytes: 10 },
  });

  expect(budgeted.limitsHit.some((l) => /read budget/.test(l))).toBeTruthy();

  const go = mkTemp();
  write(go, "go.mod", "module example.com/demo\n\ngo 1.22\n");
  const goFacts = inspect(go, NO_GIT);
  expect(goFacts.commands.some((c) => c.command === "go test ./...")).toBeTruthy();

  const pm = mkTemp();
  write(pm, "package.json", JSON.stringify({ name: "x", packageManager: "pnpm@9.0.0" }));
  write(pm, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  const pmFacts = inspect(pm, NO_GIT);
  const pnpm = pmFacts.toolchains.find((t) => t.name === "pnpm");
  expect(pnpm && pnpm.evidence.length >= 2, "lockfile + packageManager merge").toBeTruthy();
});

test("discover reports maxFiles partial results instead of silently truncating", () => {
  const dir = mkTemp();

  for (let i = 0; i < 5; i++) write(dir, `packages/p${i}/AGENTS.md`, "# Notes\n");
  const facts = inspect(dir, { ...NO_GIT, limits: { ...DEFAULT_LIMITS, maxFiles: 2 } });
  expect(facts.limitsHit.some((l) => /maxFiles/.test(l))).toBeTruthy();
});

// --- extension adapter: headless path and fail-closed registration ---

test("headless handleInit writes nothing and fail-closed registration throws", async () => {
  const dir = mkTemp();
  const notified: string[] = [];

  const message = await handleInit(
    "",
    {
      cwd: dir,
      hasUI: false,
      ui: {
        notify: (m: string) => void notified.push(m),
        select: async () => undefined,
      },
    },
  );

  expect(message).toMatch(/Interactive UI is unavailable/);
  expect(notified.join("\n")).toMatch(/Interactive UI is unavailable/);
  expect(fs.readdirSync(dir)).toEqual([]);

  const fallback: string[] = [];

  const fallbackMessage = await handleInit(
    "",
    {
      cwd: dir,
      hasUI: false,
      ui: {
        notify: (_m: string) => {
          throw new Error("headless");
        },
        select: async () => undefined,
      },
    },
    (m: string) => void fallback.push(m),
  );

  expect(fallbackMessage).toMatch(/Interactive UI is unavailable/);
  expect(fallback.join("\n")).toMatch(/Interactive UI is unavailable/);

  // SAFETY: {} lacks registerCommand on purpose; the factory must reject it.
  expect(() => initExtension({} as never)).toThrow(/pi >= 0\.85\.1/);
});

test("interactive handleInit applies on approval and registers one command", async () => {
  const dir = mkTemp();
  const notified: string[] = [];
  const seen: Array<{ name: string; handler: (args: string, ctx: never) => Promise<void> }> = [];

  initExtension({
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: never) => Promise<void> },
    ) => void seen.push({ name, handler: options.handler }),
  });
  expect(seen.length).toBe(1);
  expect(seen[0].name).toBe("init");

  const message = await handleInit(
    "",
    {
      cwd: dir,
      hasUI: true,
      ui: {
        notify: (m: string) => void notified.push(m),
        select: async (_title: string, options: string[]) => options[0],
      },
    },
  );

  expect(message).toMatch(/Wrote AGENTS\.md/);
  expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8").split(MANAGED_BEGIN).length - 1).toBe(1);

  // SAFETY: stub ctx matches the adapter's structural Pi shape; only cwd/hasUI/ui are read.
  await seen[0].handler(
    "audit",
    {
      cwd: dir,
      hasUI: true,
      ui: { notify: () => {}, select: async () => undefined },
    } as never,
  );
});

// --- non-file targets: EISDIR surfaces without writing anything ---

test("a directory at the target path refuses cleanly without writing", async () => {
  const dir = mkTemp();
  const asDir = path.join(dir, "AGENTS.md");
  fs.mkdirSync(asDir);

  // SAFETY: a directory named AGENTS.md is contrived but well-typed; it pins the
  // non-ENOENT rethrow seam (EISDIR) without fault injection or module mocking.
  expect(() =>
      applyWrite({ targetAbsPath: asDir, proposedContent: PROPOSED, baseHash: hashContent(null), root: fs.realpathSync(dir) })).toThrow(/EISDIR/);
  expect(fs.statSync(asDir).isDirectory()).toBeTruthy();
  expect(fs.readdirSync(asDir)).toEqual([]);

  const viaInit = mkTemp();
  fs.mkdirSync(path.join(viaInit, "AGENTS.md"));

  const result = await runInit(viaInit, "", silentUi(APPLY), NO_GIT);

  expect(result.wrote).toBe(false);
  expect(result.message).toMatch(/Cannot read target/);
  expect(fs.statSync(path.join(viaInit, "AGENTS.md")).isDirectory()).toBeTruthy();
});

// --- git-backed evidence: remotes surface, bare repos degrade loudly ---

test(
  "git worktree evidence names remotes; bare repos degrade with a warning",
  { skip: process.env.PI_INIT_SKIP_GIT ? true : false },
  async () => {
    const repo = mkTemp("pi-init-gaps-git-");

    const run = (args: string[], cwd: string): void => {
      const out = spawnSync("git", args, { cwd, stdio: "ignore" });
      expect(out.status, `git ${args.join(" ")} failed`).toBe(0);
    };

    run(["init"], repo);
    run(["remote", "add", "origin", "git@github.com:example/demo.git"], repo);
    write(repo, "package.json", JSON.stringify({ name: "demo" }));
    run(["add", "package.json"], repo);
    run(["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-m", "init"], repo);
    fs.appendFileSync(path.join(repo, "package.json"), "\n");

    const facts = inspect(repo);
    expect(facts.rootSource).toBe("git");

    const gitEvidence = facts.evidence.find((e) => e.kind === "git");
    expect(gitEvidence?.note).toMatch(/github\.com/);
    expect(gitEvidence?.note).toMatch(/branch \S+/);
    expect(gitEvidence?.note).toMatch(/worktree dirty/);

    const shown: string[] = [];

    const status = await runInit(repo, "status", {
      show: async (text: string): Promise<void> => {
        shown.push(text);
      },
      choose: async (): Promise<undefined> => undefined,
    });

    expect(status.wrote).toBe(false);
    expect(shown.join("\n")).toMatch(/git worktree/);

    // Output-capped git calls degrade to null, tripping the unreadable-metadata warning.
    const cappedBase = mkTemp("pi-init-gaps-capped-");
    run(["init"], cappedBase);
    write(cappedBase, "dirty.txt", "untracked\n");

    const capped = inspect(cappedBase, {
      limits: { ...DEFAULT_LIMITS, maxOutputBytes: 1 },
    });

    expect(capped.rootSource).toBe("git");
    expect(capped.warnings.some((w) => /Git metadata unreadable/.test(w))).toBeTruthy();
  },
);

// --- layering: ancestor files scope, overrides keep their kind, missing roots warn ---

test("ancestor files layer by scope; missing roots degrade without throwing", () => {
  const root = fs.realpathSync(mkTemp());
  write(root, "packages/app/AGENTS.md", "# App notes\n");
  write(root, "AGENTS.override.md", "# Owner rules\n");

  const start = path.join(root, "packages", "app", "nested");
  fs.mkdirSync(start, { recursive: true });

  const facts = inspect(start, { gitTopLevel: () => root });

  const nested = facts.instructionFiles.find((f) => f.path === "packages/app/AGENTS.md");
  expect(nested?.scope).toBe("ancestor");

  const override = facts.instructionFiles.find((f) => f.path === "AGENTS.override.md");
  expect(override?.kind).toBe("agentsOverride");

  const missing = inspect(path.join(mkTemp(), "gone"));
  expect(missing.evidence).toEqual([]);
  expect(missing.warnings.some((w) => /unreadable/.test(w))).toBeTruthy();
});

// --- adapter failures: UI closure cancels, notify failure never blocks ---

test("UI closure resolves to no write; notify failure never blocks the result", async () => {
  const closedDir = mkTemp();

  const closed = await handleInit("", {
    cwd: closedDir,
    hasUI: true,
    ui: {
      notify: () => {},
      select: async (_t: string, _o: string[]) => {
        throw new Error("dialog closed");
      },
    },
  });

  expect(closed).toMatch(/Cancelled/);
  expect(fs.readdirSync(closedDir)).toEqual([]);

  const appliedDir = mkTemp();

  const applied = await handleInit("", {
    cwd: appliedDir,
    hasUI: true,
    ui: {
      notify: (_m: string) => {
        throw new Error("unreachable ui");
      },
      select: async (_t: string, _o: string[]) => APPLY.label,
    },
  });

  expect(applied).toMatch(/Wrote AGENTS\.md/);
  expect(fs.existsSync(path.join(appliedDir, "AGENTS.md"))).toBeTruthy();
});

// --- validate matrix: unusable parents, oversize and control-char proposals ---

test("validate refuses a file parent, an oversize proposal, and control characters", () => {
  const root = fs.realpathSync(mkTemp());

  const fileAsDir = path.join(root, "file");
  fs.writeFileSync(fileAsDir, "x\n");

  const notDir = validateProposal({
    root,
    targetAbsPath: path.join(fileAsDir, "AGENTS.md"),
    proposedContent: PROPOSED,
    existingContent: null,
  });

  expect(notDir.ok).toBe(false);
  expect(notDir.errors.join(" ")).toMatch(/not a directory/);

  const oversize = validateProposal(
    {
      root,
      targetAbsPath: path.join(root, "AGENTS.md"),
      proposedContent: PROPOSED,
      existingContent: null,
    },
    { ...DEFAULT_LIMITS, maxProposedBytes: 10 },
  );

  expect(oversize.ok).toBe(false);
  expect(oversize.errors.join(" ")).toMatch(/size limit/);

  const control = validateProposal({
    root,
    targetAbsPath: path.join(root, "AGENTS.md"),
    proposedContent: `${PROPOSED}\u0007`,
    existingContent: null,
  });

  expect(control.ok).toBe(false);
  expect(control.errors.join(" ")).toMatch(/control characters/);
});

test("validate refuses a parent reached through a symlink", () => {
  const root = fs.realpathSync(mkTemp());
  const outside = fs.realpathSync(mkTemp());

  fs.symlinkSync(outside, path.join(root, "link"));

  const result = validateProposal({
    root,
    targetAbsPath: path.join(root, "link", "AGENTS.md"),
    proposedContent: PROPOSED,
    existingContent: null,
  });

  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toMatch(/symlink/);
});

test("validate refuses proposals that rewrite user-owned regions", () => {
  const root = fs.realpathSync(mkTemp());
  const existing = `# Owner notes\n\n${BLOCK}\n`;

  const result = validateProposal({
    root,
    targetAbsPath: path.join(root, "AGENTS.md"),
    proposedContent: `# Tampered notes\n\n${BLOCK}\n`,
    existingContent: existing,
  });

  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toMatch(/user-owned/);
});

// --- CRLF: Windows line endings survive replace mode untouched ---

test("replace preserves CRLF line endings end to end", () => {
  const existing = `Top.\r\n${MANAGED_BEGIN}\r\nold\r\n${MANAGED_END}\r\nBottom.\r\n`;

  const result = buildProposal(existing, BLOCK);

  expect(result.ok).toBe(true);

  if (!result.ok) return;

  expect(result.mode).toBe("replace");
  expect(result.content.includes("\r\n")).toBeTruthy();
  expect(!result.content.includes("old")).toBeTruthy();
  expect(result.content.startsWith("Top.\r\n")).toBeTruthy();
});

// --- draft: unknown command purposes render verbatim (forward-compat) ---

test("unknown command purposes render verbatim instead of vanishing", () => {
  const dir = mkTemp();
  write(dir, "package.json", JSON.stringify({ name: "demo" }));

  const facts = inspect(dir, NO_GIT);

  // SAFETY: parsed payload models a newer inspector emitting an off-union purpose;
  // the renderer must render it verbatim instead of dropping it.
  const custom = {
    ...facts,
    commands: JSON.parse(
      `[{"purpose": "canary", "command": "canary run", "source": "package.json"}]`,
    ) as DiscoveredCommand[],
  };

  const draft = buildDraft(custom, selectTarget(facts));

  expect(draft.managedBlock).toMatch(/- canary: `canary run` \(from package\.json\)\./);
});

// --- audit budget: bullets, bytes, and categories all flag with caps ---

test("audit reports every budget dimension with caps and categories", async () => {
  const dir = mkTemp();
  const bullets = Array.from({ length: 13 }, (_, i) => `- Test: \`cmd-${i}\` (from package.json).`);

  bullets.push("- Docs: keep.", "- Requires: patience.", `-${" ".repeat(4)}`);

  const pad = "x".repeat(34 * 1024);
  write(dir, "package.json", JSON.stringify({ name: "demo" }));
  write(dir, "AGENTS.md", `# Owner\n\n${MANAGED_BEGIN}\n${bullets.join("\n")}\n${pad}\n${MANAGED_END}\n`);

  const shown: string[] = [];

  const result = await runInit(
    dir,
    "audit",
    {
      show: async (text: string): Promise<void> => {
        shown.push(text);
      },
      choose: async (): Promise<undefined> => undefined,
    },
    NO_GIT,
  );

  expect(result.wrote).toBe(false);

  const out = shown.join("\n");
  expect(out).toMatch(/16 bullets \(cap 12\)/);
  expect(out).toMatch(/bytes \(limit 32768\)/);
  expect(out).toMatch(/possibly stale/);
  expect(out).toMatch(/\+3 more/);
  expect(out).toMatch(/Test 13 bullet/);
  expect(out).toMatch(/other 1 bullet/);
});

// --- audit references: long lists cap, outside-root refs report, secrets redact ---

test("audit caps reference lists, reports outside-root refs, and redacts secrets", async () => {
  const dir = mkTemp();
  const links = Array.from({ length: 11 }, (_, i) => `[gone-${i}](docs/gone-${i}.md)`).join(" ");

  write(
    dir,
    "AGENTS.md",
    `# Owner\npassword = hunter2-plain-value\n\n${MANAGED_BEGIN}\n- See ${links} and [up](../escape.md). Also [site](https://example.com/guide) and raw https://example.com/raw.\n${MANAGED_END}\n`,
  );

  const shown: string[] = [];

  const result = await runInit(
    dir,
    "audit",
    {
      show: async (text: string): Promise<void> => {
        shown.push(text);
      },
      choose: async (): Promise<undefined> => undefined,
    },
    NO_GIT,
  );

  expect(result.wrote).toBe(false);

  const out = shown.join("\n");
  expect(out).toMatch(/docs\/gone-0\.md/);
  expect(out).toMatch(/\+2 more/);
  expect(out).toMatch(/\.\.\/escape\.md/);
  expect(out).not.toMatch(/example\.com/);
  expect(out).toMatch(/user-owned region/);
  expect(out).not.toMatch(/hunter2-plain-value/);
});

// --- audit edge: an empty managed section reports no categories ---

test("audit reports an empty managed section with no categories", async () => {
  const dir = mkTemp();
  write(dir, "AGENTS.md", `# Owner\n\n${MANAGED_BEGIN}\n${MANAGED_END}\n`);

  const shown: string[] = [];
  await runInit(
    dir,
    "audit",
    {
      show: async (text: string): Promise<void> => {
        shown.push(text);
      },
      choose: async (): Promise<undefined> => undefined,
    },
    NO_GIT,
  );

  expect(shown.join("\n")).toMatch(/Space by category: none/);
});

// --- manifests: ordering is deterministic, odd shapes degrade gracefully ---

test("multiple lockfiles, engines, and odd script shapes stay deterministic", () => {
  const dir = mkTemp();
  write(
    dir,
    "package.json",
    JSON.stringify({
      name: "demo",
      engines: { node: ">=20", npm: ">=10" },
      scripts: { test: "echo C:\\\\temp && vitest run", nested: { deep: "x" } },
    }),
  );
  write(dir, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  write(dir, "package-lock.json", "{}\n");
  write(dir, "Cargo.toml", '[package]\nname = "demo"\n');

  const first = inspect(dir, NO_GIT);
  const second = inspect(dir, NO_GIT);
  expect(second).toEqual(first);

  const toolchains = first.toolchains.map((t) => t.name);
  expect(toolchains).toEqual([...toolchains].sort());
  expect(toolchains.includes("pnpm")).toBeTruthy();
  expect(toolchains.includes("npm")).toBeTruthy();
  expect(first.commands.some((c) => c.purpose === "test" && c.source === "package.json")).toBeTruthy();
  expect(first.constraints.length >= 2).toBeTruthy();

  const odd = mkTemp();
  fs.mkdirSync(path.join(odd, "package.json"));

  const oddFacts = inspect(odd, NO_GIT);
  expect(!oddFacts.detectedStacks.some((s) => s.evidence.includes("package.json"))).toBeTruthy();
});

// --- layering kinds: every filename keeps its kind at every scope ---

test("override and claude files keep their kind in nested scopes", () => {
  const root = fs.realpathSync(mkTemp());
  write(root, "packages/app/AGENTS.override.md", "# App rules\n");
  write(root, "packages/other/CLAUDE.md", "# Other notes\n");
  write(root, "packages/CLAUDE.md", "# Packages notes\n");
  fs.mkdirSync(path.join(root, "packages", "app", "nested"), { recursive: true });

  const facts = inspect(path.join(root, "packages", "app", "nested"), {
    gitTopLevel: () => root,
  });

  const override = facts.instructionFiles.find((f) => f.path === "packages/app/AGENTS.override.md");
  expect(override?.kind).toBe("agentsOverride");
  expect(override?.scope).toBe("ancestor");

  const ancestorClaude = facts.instructionFiles.find((f) => f.path === "packages/CLAUDE.md");
  expect(ancestorClaude?.kind).toBe("claude");
  expect(ancestorClaude?.scope).toBe("ancestor");

  const claude = facts.instructionFiles.find((f) => f.path === "packages/other/CLAUDE.md");
  expect(claude?.kind).toBe("claude");
  expect(claude?.scope).toBe("nested");

  const fromRoot = inspect(root, { gitTopLevel: () => root });

  const nestedOverride = fromRoot.instructionFiles.find(
    (f) => f.path === "packages/app/AGENTS.override.md",
  );

  expect(nestedOverride?.kind).toBe("agentsOverride");
  expect(nestedOverride?.scope).toBe("nested");
});

// --- bounds: maxDepth contains the nested search ---

test("maxDepth zero skips the nested search without failing", () => {
  const dir = mkTemp();
  write(dir, "packages/app/AGENTS.md", "# App\n");

  const facts = inspect(dir, {
    ...NO_GIT,
    limits: { ...DEFAULT_LIMITS, maxDepth: 0 },
  });

  expect(!facts.instructionFiles.some((f) => f.scope === "nested")).toBeTruthy();
});

// --- read-only modes surface read failures without writing ---

test("audit surfaces an unreadable target as a message, writing nothing", async () => {
  const dir = mkTemp();
  write(dir, "AGENTS.md", "# Owner\n");

  const shown: string[] = [];

  const result = await runInit(
    dir,
    "audit",
    {
      show: async (text: string): Promise<void> => {
        shown.push(text);
      },
      choose: async (): Promise<undefined> => undefined,
    },
    {
      ...NO_GIT,
      readFile: (): string | null => {
        throw new Error("EACCES");
      },
    },
  );

  expect(result.wrote).toBe(false);
  expect(result.message).toMatch(/Cannot read target/);
  expect(shown.length).toBe(0);
  expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("# Owner\n");
});

// --- adapter fallback: a cwd-less context resolves to the process cwd ---

test("handler without cwd audits the process tree read-only", async () => {
  const seen: Array<{ name: string; handler: (args: string, ctx: never) => Promise<void> }> = [];

  initExtension({
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: never) => Promise<void> },
    ) => void seen.push({ name, handler: options.handler }),
  });

  const notified: string[] = [];

  // SAFETY: omitting cwd exercises the process.cwd() fallback; audit mode never writes.
  await seen[0].handler(
    "audit",
    {
      hasUI: true,
      ui: {
        notify: (message: string): void => {
          notified.push(message);
        },
        select: async (): Promise<undefined> => undefined,
      },
    } as never,
  );

  const out = notified.join("\n");
  expect(out).toMatch(/nothing was written/);
  expect(out).toMatch(/git worktree/);
});

// --- mid-apply sabotage: a directory swapped in aborts with the write-failure message ---

test("target replaced by a directory between preview and apply aborts safely", async () => {
  const dir = mkTemp();
  const target = path.join(dir, "AGENTS.md");
  fs.writeFileSync(target, "# Manual\n");

  const sabotageUi: InteractionPort = {
    show: async (): Promise<void> => {},
    choose: async (): Promise<Choice | undefined> => {
      fs.rmSync(target);
      fs.mkdirSync(target);

      return APPLY;
    },
  };

  const result = await runInit(dir, "", sabotageUi, NO_GIT);

  expect(result.wrote).toBe(false);
  expect(result.message).toMatch(/Write failed, nothing was replaced/);
  expect(fs.statSync(target).isDirectory()).toBeTruthy();
  expect(fs.readdirSync(target)).toEqual([]);
});

// --- headless fallback: notify failure reaches the caller hook ---

test("headless read-only modes point at the report, not at applying", async () => {
  const dir = mkTemp();

  const message = await handleInit("audit", {
    cwd: dir,
    hasUI: false,
    ui: {
      notify: (): void => {},
      select: async (): Promise<undefined> => undefined,
    },
  });

  expect(message).toMatch(
    /Interactive UI is unavailable; rerun \/init in the TUI to see the full report\./,
  );
  expect(fs.readdirSync(dir)).toEqual([]);
});

test("headless notify failure falls back to the caller hook", async () => {
  const dir = mkTemp();
  const fallback: string[] = [];

  const message = await handleInit(
    "",
    {
      cwd: dir,
      hasUI: false,
      ui: {
        notify: (_m: string): void => {
          throw new Error("no ui");
        },
        select: async (): Promise<undefined> => undefined,
      },
    },
    (text: string): void => {
      fallback.push(text);
    },
  );

  expect(message).toMatch(/Interactive UI is unavailable/);
  expect(fallback.join("\n")).toMatch(/Interactive UI is unavailable/);
  expect(fs.readdirSync(dir)).toEqual([]);
});

// --- manifests: tiny byte budgets degrade across every manifest kind ---

test("tiny byte budgets degrade across every manifest kind", () => {
  const dir = mkTemp();
  write(dir, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }));
  write(dir, "Cargo.toml", '[package]\nname = "demo"\n');
  write(dir, "pyproject.toml", '[project]\nname = "demo"\n');

  const facts = inspect(dir, {
    ...NO_GIT,
    limits: { ...DEFAULT_LIMITS, maxTotalBytes: 10 },
  });

  expect(facts.commands).toEqual([]);
  expect(facts.limitsHit.filter((l) => /read budget/.test(l))).toHaveLength(1);
});

// --- summary rendering: hit limits display as limit lines ---

test("status renders hit limits as limit lines", async () => {
  const dir = mkTemp();
  write(dir, "package.json", JSON.stringify({ name: "demo" }));
  write(dir, "packages/a/AGENTS.md", "# A\n");
  write(dir, "packages/b/AGENTS.md", "# B\n");

  const shown: string[] = [];

  const result = await runInit(
    dir,
    "status",
    {
      show: async (text: string): Promise<void> => {
        shown.push(text);
      },
      choose: async (): Promise<undefined> => undefined,
    },
    { ...NO_GIT, limits: { ...DEFAULT_LIMITS, maxFiles: 2 } },
  );

  expect(result.wrote).toBe(false);
  expect(shown.join("\n")).toMatch(/Limit: maxFiles/);
});

// --- diff rendering: removals and additions both show ---

test("renderDiff shows removed and added lines", () => {
  const diff = renderDiff("a\nb\n", "a\nc\n");

  expect(diff).toMatch(/- b/);
  expect(diff).toMatch(/\+ c/);
  expect(diff).toMatch(/--- current/);
  expect(diff).toMatch(/@@ -2,1 \+2,1 @@/);
});

test("renderDiff labels hunk kinds for new files, additions, and deletions", () => {
  expect(renderDiff(null, "a\nb\n")).toMatch(/new file/);
  expect(renderDiff("a\n", "a\nb\n")).toMatch(/pure addition/);
  expect(renderDiff("a\nb\n", "a\n")).toMatch(/pure deletion/);
});

// --- root fallback: unresolvable start directories resolve to themselves ---

test("unresolvable start directories fall back to themselves", () => {
  const missing = path.join(fs.realpathSync(mkTemp()), "gone");

  const resolved = resolveRoot(missing);

  expect(resolved.rootSource).toBe("cwd");
});

// --- audit references: custom existence views drive stale detection ---

test("stale detection follows the injected existence view", () => {
  const dir = mkTemp();
  write(dir, "README.md", "# Real\n");

  const facts = inspect(dir, NO_GIT);
  const target = selectTarget(facts);
  const existing = `# Owner\n\n${MANAGED_BEGIN}\n- See [real](README.md) and [gone](docs/gone.md).\n${MANAGED_END}\n`;

  const stale = buildAuditReport(facts, target, existing, DEFAULT_LIMITS, () => false);
  expect(stale).toMatch(/docs\/gone\.md/);

  const fresh = buildAuditReport(
    facts,
    target,
    existing,
    DEFAULT_LIMITS,
    (absPath: string) => absPath.endsWith("README.md"),
  );

  expect(fresh).toMatch(/docs\/gone\.md/);
  expect(fresh).not.toMatch(/README\.md.*[Ss]tale|[Ss]tale.*README\.md/);
});
