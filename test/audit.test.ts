// Ticket 05: read-only audit and status. Both modes summarize without
// writing anything (not even temp files), label heuristic judgment calls,
// redact secret values, and report monorepo scoping. Tested at the same
// seam as tickets 02/04: runInit() with a stub UI over temp directories.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { runInit, type Choice, type InteractionPort } from "../src/command.js";
import { MANAGED_BEGIN, MANAGED_END } from "../src/facts.js";

const NO_GIT = { gitTopLevel: () => null };

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-init-audit-"));
}

interface Capture {
  shown: string[];
  chooseCalls: string[];
  ui: InteractionPort;
}

function capture(): Capture {
  const shown: string[] = [];
  const chooseCalls: string[] = [];

  return {
    shown,
    chooseCalls,
    ui: {
      show: async (text: string): Promise<void> => {
        shown.push(text);
      },
      choose: async (title: string): Promise<Choice | undefined> => {
        chooseCalls.push(title);

        return undefined;
      },
    },
  };
}

/** Recursive path:size:hash listing; read-only modes must leave it identical. */
function snapshot(dir: string): string {
  const out: string[] = [];

  const walk = (d: string): void => {
    const entries = fs.readdirSync(d, { withFileTypes: true });

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const abs = path.join(d, entry.name);
      const rel = path.relative(dir, abs).split(path.sep).join("/");

      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(abs);
        out.push(`${rel}:${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
      } else {
        out.push(`${rel}:special`);
      }
    }
  };

  walk(dir);

  return out.join("\n");
}

function managedBlock(lines: string[]): string {
  return `${MANAGED_BEGIN}\n${lines.join("\n")}\n${MANAGED_END}`;
}

test("status reports root, layering, target, and exclusions without writing", async () => {
  const dir = mkTemp();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node --test" } }),
  );
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Owner notes\n");
  fs.mkdirSync(path.join(dir, "packages", "app"), { recursive: true });
  fs.writeFileSync(path.join(dir, "packages", "app", "AGENTS.md"), "# App notes\n");

  const before = snapshot(dir);
  const cap = capture();
  const result = await runInit(dir, "status", cap.ui, NO_GIT);

  expect(result.wrote).toBe(false);
  expect(result.message).toMatch(/nothing was written/i);
  expect(cap.chooseCalls.length, "status must not ask for confirmation").toBe(0);

  const shown = cap.shown.join("\n");
  expect(shown).toMatch(/Analysis root:/);
  expect(shown).toMatch(/Target: AGENTS\.md \(update\)/);
  expect(shown).toMatch(/packages\/app\/AGENTS\.md/);
  expect(shown).toMatch(/Skipped:/);
  expect(snapshot(dir), "status must leave the tree identical").toBe(before);
});

test("status on an empty dir proposes creation and writes nothing", async () => {
  const dir = mkTemp();
  const cap = capture();
  const result = await runInit(dir, "status", cap.ui, NO_GIT);

  expect(result.wrote).toBe(false);
  expect(cap.shown.join("\n")).toMatch(/Target: AGENTS\.md \(create\)/);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test("audit on a fresh draft reports valid markers and writes nothing", async () => {
  const dir = mkTemp();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node --test" } }),
  );
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    `# Owner\n\n${managedBlock(["## Managed instructions (pi-init)", "- Test: `npm run test` (from package.json)."])}\n`,
  );

  const before = snapshot(dir);
  const cap = capture();
  const result = await runInit(dir, "audit", cap.ui, NO_GIT);

  expect(result.wrote).toBe(false);
  expect(result.message).toMatch(/nothing was written/i);
  expect(cap.chooseCalls.length, "audit must not ask for confirmation").toBe(0);

  const shown = cap.shown.join("\n");
  expect(shown).toMatch(/marker/i);
  expect(shown).toMatch(/valid/i);
  expect(shown).not.toMatch(/possibly stale/i);
  expect(snapshot(dir), "audit must leave the tree identical").toBe(before);
});

test("audit flags commands missing from manifests as possibly stale", async () => {
  const dir = mkTemp();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node --test" } }),
  );
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    `# Owner\n\n${managedBlock(["## Managed instructions (pi-init)", "- Test: `npm run spec` (from package.json)."])}\n`,
  );

  const cap = capture();
  const result = await runInit(dir, "audit", cap.ui, NO_GIT);

  expect(result.wrote).toBe(false);
  const shown = cap.shown.join("\n");
  expect(shown).toMatch(/possibly stale/i);
  expect(shown).toMatch(/npm run spec/);
});

test("audit flags unresolvable links as deterministic stale references", async () => {
  const dir = mkTemp();
  fs.writeFileSync(path.join(dir, "README.md"), "# Real docs\n");
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    `# Owner\n\n${managedBlock(["## Managed instructions (pi-init)", "- See [gone](docs/gone.md) and [readme](README.md)."])}\n`,
  );

  const cap = capture();
  await runInit(dir, "audit", cap.ui, NO_GIT);

  const shown = cap.shown.join("\n");
  expect(shown).toMatch(/docs\/gone\.md/);
  expect(shown).toMatch(/[Ss]tale/);
  expect(shown).toMatch(/Deterministic/);
  expect(shown).not.toMatch(/README\.md.*[Ss]tale|[Ss]tale.*README\.md/);
});

test("audit reports monorepo root leakage with nothing auto-created", async () => {
  const dir = mkTemp();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node --test" } }),
  );
  fs.mkdirSync(path.join(dir, "packages", "app"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "packages", "app", "package.json"),
    JSON.stringify({ name: "app" }),
  );
  fs.writeFileSync(path.join(dir, "packages", "app", "AGENTS.md"), "# App notes\n");
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    `# Owner\n\n${managedBlock(["## Managed instructions (pi-init)", "- Build: `npm run build` (from packages/app/package.json)."])}\n`,
  );

  const before = snapshot(dir);
  const cap = capture();
  const result = await runInit(dir, "audit", cap.ui, NO_GIT);

  expect(result.wrote).toBe(false);
  const shown = cap.shown.join("\n");
  expect(shown).toMatch(/packages\/app/);
  expect(shown).toMatch(/Heuristic/);
  expect(shown).toMatch(/package-local|scoped/i);
  expect(snapshot(dir), "audit must auto-create nothing").toBe(before);
});

test("audit never shows secret values", async () => {
  const dir = mkTemp();
  const secret = "hunter2-secret-value-xyz";
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    `# Owner\n\n${managedBlock(["## Managed instructions (pi-init)", `- Deploy key: api_key = ${secret} (from .env).`])}\n`,
  );

  const cap = capture();
  await runInit(dir, "audit", cap.ui, NO_GIT);

  const shown = cap.shown.join("\n");
  expect(shown).not.toMatch(new RegExp(secret));
  expect(shown).toMatch(/secret/i);
});

test("audit reports malformed markers with a fix and writes nothing", async () => {
  const dir = mkTemp();
  const existing = `# Owner\n${MANAGED_BEGIN}\nno end marker\n`;
  fs.writeFileSync(path.join(dir, "AGENTS.md"), existing);

  const cap = capture();
  const result = await runInit(dir, "audit", cap.ui, NO_GIT);

  expect(result.wrote).toBe(false);
  expect(cap.shown.join("\n")).toMatch(/marker/i);
  expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(existing);
});

test("audit and status are deterministic across runs", async () => {
  const dir = mkTemp();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Owner\n");

  const first = capture();
  await runInit(dir, "audit", first.ui, NO_GIT);
  const second = capture();
  await runInit(dir, "audit", second.ui, NO_GIT);
  expect(second.shown.join("\n")).toBe(first.shown.join("\n"));

  const third = capture();
  await runInit(dir, "status", third.ui, NO_GIT);
  const fourth = capture();
  await runInit(dir, "status", fourth.ui, NO_GIT);
  expect(fourth.shown.join("\n")).toBe(third.shown.join("\n"));
});

test("audit budgets count fact bullets, not the copy-only pointer", async () => {
  const dir = mkTemp();
  // 12 bullets x 16 words = 192 words (within budget); the pointer line and
  // header push total section words over 200, and the pointer pushes
  // "- " line count to 13. Both must stay outside the budget measurement.
  const facts = Array.from({ length: 12 }, (_, i) => `- Fact ${i + 1}: ${"evidence ".repeat(12)}traced.`);
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    `# Owner\n\n${managedBlock([
      "## Managed instructions (pi-init)",
      ...facts,
      "- (1 further fact(s) held for the copy-only expanded draft; choose Copy/print to view.)",
    ])}\n`,
  );

  const cap = capture();
  await runInit(dir, "audit", cap.ui, NO_GIT);

  const shown = cap.shown.join("\n");
  expect(shown).toMatch(/within the instruction budget \(~192\/200 words, 12\/12 bullets\)/);
  expect(shown).not.toMatch(/exceeds the instruction budget/);
  expect(shown).not.toMatch(/Space by category:.*further fact/);
});

test("update re-runs the init flow", async () => {
  const dir = mkTemp();
  const cap = capture();
  const choices = (await import("../src/command.js")).CHOICES;

  const applyUi: InteractionPort = {
    show: cap.ui.show,
    choose: async (): Promise<Choice | undefined> => choices[0],
  };

  const result = await runInit(dir, "update", applyUi, NO_GIT);

  expect(result.wrote).toBe(true);
  expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toMatch(new RegExp(MANAGED_BEGIN));
});
