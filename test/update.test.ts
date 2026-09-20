// Ticket 04: safe update of existing guidance. Re-runs preserve
// user-owned content byte-for-byte, default to appending a managed
// section, refuse malformed markers and symlink escapes, honor override
// precedence, and yield minimal managed-section diffs on manifest change.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { CHOICES, runInit, type Choice, type InteractionPort } from "../src/command.js";
import { MANAGED_BEGIN, MANAGED_END } from "../src/facts.js";

const APPLY = CHOICES[0];

const BLOCK = `${MANAGED_BEGIN}\n## Managed instructions (pi-init)\n- A fact.\n${MANAGED_END}`;

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-init-update-"));
}

function applyUi(log: string[]): InteractionPort {
  return {
    show: async (text: string): Promise<void> => {
      log.push(text);
    },
    choose: async (): Promise<Choice | undefined> => APPLY,
  };
}

const NO_GIT = { gitTopLevel: () => null };

/** User-owned regions: the file with the managed section removed. */
function outside(text: string): string {
  const bi = text.indexOf(MANAGED_BEGIN);

  if (bi < 0) return text;
  const ei = text.indexOf(MANAGED_END) + MANAGED_END.length;

  return text.slice(0, bi) + text.slice(ei);
}

function managed(text: string): string {
  const bi = text.indexOf(MANAGED_BEGIN);
  const ei = text.indexOf(MANAGED_END) + MANAGED_END.length;

  return text.slice(bi, ei);
}

function targetOf(dir: string, name = "AGENTS.md"): string {
  return path.join(fs.realpathSync(dir), name);
}

test("unmarked file defaults to append; manual bytes survive verbatim", async () => {
  const dir = mkTemp();
  const existing = "# Owner notes\n\nKeep every byte.\n";
  fs.writeFileSync(path.join(dir, "AGENTS.md"), existing);

  const result = await runInit(dir, "", applyUi([]), NO_GIT);
  expect(result.wrote).toBe(true);
  const content = fs.readFileSync(targetOf(dir), "utf8");
  expect(content.startsWith(existing), "manual prefix must be byte-identical").toBeTruthy();
  expect(content.split(MANAGED_BEGIN).length - 1).toBe(1);
  expect(content.split(MANAGED_END).length - 1).toBe(1);
});

test("second run after a manifest change touches only the managed section", async () => {
  const dir = mkTemp();
  const manifest = path.join(dir, "package.json");
  fs.writeFileSync(manifest, JSON.stringify({ name: "x", scripts: { test: "node --test" } }));

  const first = await runInit(dir, "", applyUi([]), NO_GIT);
  expect(first.wrote).toBe(true);

  // Simulate the user adding manual content around the managed section.
  const v1 = fs.readFileSync(targetOf(dir), "utf8");
  const edited = `# Owner note: keep.\n\n${v1}Trailing remark.\n`;
  fs.writeFileSync(targetOf(dir), edited);

  // Manifest change: a new lint script enters the draft.
  fs.writeFileSync(
    manifest,
    JSON.stringify({ name: "x", scripts: { test: "node --test", lint: "oxlint src" } }),
  );

  const log: string[] = [];
  const second = await runInit(dir, "", applyUi(log), NO_GIT);
  expect(second.wrote).toBe(true);
  const v2 = fs.readFileSync(targetOf(dir), "utf8");
  expect(outside(v2), "user-owned regions must be byte-identical").toBe(outside(edited));
  expect(managed(v2), "managed section must reflect the new script").not.toBe(managed(edited));
  expect(managed(v2)).toMatch(/lint/i);
});

const malformedCases: Array<[string, string]> = [
  ["missing end", `# Manual\n${MANAGED_BEGIN}\nno end\n`],
  ["missing begin", `# Manual\n${MANAGED_END}\n`],
  ["duplicated", `# Manual\n${BLOCK}\n${BLOCK}\n`],
  ["reversed", `# Manual\n${MANAGED_END}\n${MANAGED_BEGIN}\n`],
  ["nested", `${MANAGED_BEGIN}\n${BLOCK}\n${MANAGED_END}\n`],
];

for (const [name, existing] of malformedCases) {
  test(`malformed markers refuse the write with a fix message: ${name}`, async () => {
    const dir = mkTemp();
    const target = path.join(dir, "AGENTS.md");
    fs.writeFileSync(target, existing);

    const result = await runInit(dir, "", applyUi([]), NO_GIT);
    expect(result.wrote).toBe(false);
    expect(result.message).toMatch(/marker/i);
    expect(fs.readFileSync(target, "utf8"), "refused write leaves the file alone").toBe(existing);
  });
}

test("override plus manual AGENTS.md: override untouched, manual preserved", async () => {
  const dir = mkTemp();
  const override = "# Owner rules\n";
  fs.writeFileSync(path.join(dir, "AGENTS.override.md"), override);
  const manual = "# Team notes\n\nDo not touch.\n";
  fs.writeFileSync(path.join(dir, "AGENTS.md"), manual);

  const log: string[] = [];
  const result = await runInit(dir, "", applyUi(log), NO_GIT);
  expect(result.wrote).toBe(true);
  expect(fs.readFileSync(path.join(dir, "AGENTS.override.md"), "utf8")).toBe(override);
  const content = fs.readFileSync(targetOf(dir), "utf8");
  expect(content.startsWith(manual), "manual prefix must be byte-identical").toBeTruthy();
  expect(log.join("\n")).toMatch(/override/i);
});

test("CLAUDE-only project explains the AGENTS.md alternative before targeting", async () => {
  const dir = mkTemp();
  const manual = "# Claude notes\n\nKeep.\n";
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), manual);

  const log: string[] = [];
  const result = await runInit(dir, "", applyUi(log), NO_GIT);
  expect(result.wrote).toBe(true);
  expect(result.path).toBe(targetOf(dir, "CLAUDE.md"));
  expect(!fs.existsSync(path.join(dir, "AGENTS.md")), "no alternative file is created").toBeTruthy();
  const shown = log.join("\n");
  expect(shown).toMatch(/Target: CLAUDE\.md \(update\)/);
  expect(shown).toMatch(/AGENTS\.md/);
  const content = fs.readFileSync(targetOf(dir, "CLAUDE.md"), "utf8");
  expect(content.startsWith(manual), "manual prefix must be byte-identical").toBeTruthy();
});

test("symlink target refuses the write and leaves the link alone", async () => {
  const dir = mkTemp();
  const real = path.join(dir, "real.md");
  fs.writeFileSync(real, "# Real\n");
  fs.symlinkSync(real, path.join(dir, "AGENTS.md"));

  const result = await runInit(dir, "", applyUi([]), NO_GIT);
  expect(result.wrote).toBe(false);
  expect(result.message).toMatch(/symlink/i);
  expect(fs.readFileSync(real, "utf8")).toBe("# Real\n");
});
