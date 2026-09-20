// Ticket 03, slice 1: stacks' commands and toolchains come from manifests.
// Public seams only: inspect() facts and buildDraft() text.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { runInit, type Choice } from "../src/command.js";
import { inspect } from "../src/discover.js";
import { DEFAULT_LIMITS } from "../src/config.js";
import { buildDraft } from "../src/draft.js";
import { selectTarget } from "../src/target.js";

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-init-discover-"));
}

function writeAdriatic(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

test("node project: scripts map to purposes, lockfile names the toolchain", () => {
  const dir = mkTemp();
  writeAdriatic(
    dir,
    "package.json",
    JSON.stringify({
      name: "demo",
      description: "Demo shop.",
      scripts: { test: "vitest run", lint: "eslint .", build: "tsc" },
    }),
  );
  writeAdriatic(dir, "pnpm-lock.yaml", "lockfileVersion: 9\n");

  const facts = inspect(dir, { gitTopLevel: () => null });
  expect(facts.commands.map((c) => `${c.purpose}:${c.command}`).sort()).toEqual(["build:pnpm run build", "lint:pnpm run lint", "test:pnpm run test"]);
  expect(facts.commands.every((c) => c.source === "package.json")).toBeTruthy();
  expect(facts.evidence.some((e) => e.path === "pnpm-lock.yaml" && /pnpm/.test(e.note)), "lockfile toolchain evidence").toBeTruthy();

  const draft = buildDraft(facts, selectTarget(facts)).managedBlock;
  expect(draft).toMatch(/pnpm run test/);
  expect(draft).toMatch(/pnpm run lint/);
});

test("rust and python manifests yield purpose, constraints, and canonical commands", () => {
  const rustDir = mkTemp();
  writeAdriatic(
    rustDir,
    "Cargo.toml",
    '[package]\nname = "demo"\ndescription = "Blazing demo."\nrust-version = "1.78"\n',
  );

  const rust = inspect(rustDir, { gitTopLevel: () => null });
  expect(rust.purpose).toEqual({ text: "Blazing demo.", source: "Cargo.toml" });
  expect(rust.constraints).toEqual([{ text: "rust 1.78", source: "Cargo.toml" }]);
  expect(rust.commands.some((c) => c.purpose === "test" && c.command === "cargo test"), "cargo test evidenced").toBeTruthy();

  const pyDir = mkTemp();
  writeAdriatic(
    pyDir,
    "pyproject.toml",
    '[project]\nname = "demo"\ndescription = "Calm demo."\nrequires-python = ">=3.11"\n[tool.pytest.ini_options]\n[tool.ruff]\n',
  );

  const py = inspect(pyDir, { gitTopLevel: () => null });
  expect(py.purpose).toEqual({ text: "Calm demo.", source: "pyproject.toml" });
  expect(py.constraints).toEqual([{ text: "python >=3.11", source: "pyproject.toml" }]);
  expect(py.commands.some((c) => c.command === "pytest" && c.source === "pyproject.toml")).toBeTruthy();
  expect(py.commands.some((c) => c.command === "ruff check")).toBeTruthy();
});

test("minimal pyproject omits test/lint commands", () => {
  const dir = mkTemp();
  writeAdriatic(dir, "pyproject.toml", '[project]\nname = "demo"\n');

  const facts = inspect(dir, { gitTopLevel: () => null });
  expect(facts.commands).toEqual([]);
});

test("weak categories are omitted: no description, no scripts, no constraints", () => {
  const dir = mkTemp();
  writeAdriatic(dir, "package.json", JSON.stringify({ name: "bare", scripts: {} }));

  const facts = inspect(dir, { gitTopLevel: () => null });
  expect(facts.purpose).toBe(null);
  expect(facts.commands).toEqual([]);
  expect(facts.constraints).toEqual([]);

  const draft = buildDraft(facts, selectTarget(facts)).managedBlock;
  expect(draft).not.toMatch(/purpose/i);
  expect(draft).not.toMatch(/Requires/i);
  expect(draft).toMatch(/Stack: node/);
});

test("contributor docs become a pointer, never copied content", () => {
  const dir = mkTemp();
  writeAdriatic(dir, "package.json", JSON.stringify({ name: "demo" }));
  writeAdriatic(dir, "CONTRIBUTING.md", "# Contribute\n\nRun everything twice.\n");

  const facts = inspect(dir, { gitTopLevel: () => null });
  const draft = buildDraft(facts, selectTarget(facts)).managedBlock;
  expect(draft).toMatch(/CONTRIBUTING\.md/);
  expect(draft).not.toMatch(/Run everything twice/);
});

test("rich draft over the word budget holds overflow for copy-only viewing", () => {
  const dir = mkTemp();
  writeAdriatic(
    dir,
    "package.json",
    JSON.stringify({
      name: "demo",
      description: "Demo shop.",
      engines: { node: ">=20" },
      scripts: {
        test: "vitest run",
        lint: "eslint .",
        format: "prettier --write .",
        build: "tsc",
        dev: "vite",
      },
    }),
  );
  writeAdriatic(dir, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  writeAdriatic(dir, "CONTRIBUTING.md", "# Contribute\n");

  const facts = inspect(dir, { gitTopLevel: () => null });
  const tiny = { ...DEFAULT_LIMITS, maxDraftWords: 12 };
  const draft = buildDraft(facts, selectTarget(facts), tiny);

  expect(draft.overflow.length > 0, "expected held-back facts").toBeTruthy();
  expect(draft.managedBlock).toMatch(/copy-only/);

  for (const held of draft.overflow) {
    expect(draft.managedBlock.includes(held)).toBe(false);
  }

  expect(draft.managedBlock).toMatch(/Purpose: Demo shop/);
});

test("secrets in repo text never reach the draft, preview, or file", async () => {
  const dir = mkTemp();
  writeAdriatic(
    dir,
    "package.json",
    JSON.stringify({
      name: "demo",
      description: "Demo with api_key=AKIAIOSFODNN7EXAMPLE inside.",
      scripts: { test: "vitest run --token=s3cr3t-token-value" },
    }),
  );
  writeAdriatic(dir, "README.md", "# Demo\n\npassword=hunter2\n");

  const facts = inspect(dir, { gitTopLevel: () => null });
  const draft = buildDraft(facts, selectTarget(facts));

  expect(draft.managedBlock).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
  expect(draft.managedBlock).not.toMatch(/hunter2/);

  const log: string[] = [];

  const ui = {
    show: async (text: string): Promise<void> => {
      log.push(text);
    },
    choose: async (): Promise<Choice> => ({ id: "apply", label: "Apply" }),
  };

  const result = await runInit(dir, "", ui, { gitTopLevel: () => null });

  expect(result.wrote).toBe(true);
  expect(log.join("\n")).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
  expect(log.join("\n")).not.toMatch(/hunter2/);

  const written = fs.readFileSync(path.join(fs.realpathSync(dir), "AGENTS.md"), "utf8");
  expect(written).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
  expect(written).not.toMatch(/hunter2/);
  expect(written).toMatch(/\[redacted\]/);
});

test("same facts in produce an identical draft (snapshot)", () => {
  const dir = mkTemp();
  writeAdriatic(
    dir,
    "package.json",
    JSON.stringify({ name: "demo", description: "Demo shop.", scripts: { test: "vitest run" } }),
  );
  writeAdriatic(dir, "pnpm-lock.yaml", "lockfileVersion: 9\n");

  const first = inspect(dir, { gitTopLevel: () => null });
  const second = inspect(dir, { gitTopLevel: () => null });
  expect(second).toEqual(first);

  const target = selectTarget(first);
  expect(buildDraft(second, target).managedBlock).toBe(buildDraft(first, target).managedBlock);
  expect(buildDraft(first, target).managedBlock).toBe([
      "<!-- pi-init:begin -->",
      "## Managed instructions (pi-init)",
      "- Purpose: Demo shop. (from package.json).",
      "- Toolchain: pnpm (evidenced by pnpm-lock.yaml).",
      "- Stack: node (evidenced by package.json).",
      "- Test: `pnpm run test` (from package.json).",
      "<!-- pi-init:end -->",
    ].join("\n"));
});

test("proposal states the default exclusions", async () => {
  const dir = mkTemp();
  writeAdriatic(dir, "package.json", JSON.stringify({ name: "demo" }));

  const log: string[] = [];

  const ui = {
    show: async (text: string): Promise<void> => {
      log.push(text);
    },
    choose: async (): Promise<undefined> => undefined,
  };

  await runInit(dir, "", ui, { gitTopLevel: () => null });

  expect(log.join("\n")).toMatch(/Skipped:.*node_modules/);
});
