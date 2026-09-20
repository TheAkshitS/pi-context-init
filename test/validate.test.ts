import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { MANAGED_BEGIN, MANAGED_END } from "../src/facts.js";
import { validateProposal } from "../src/validate.js";

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-init-validate-"));
}

const BLOCK = `${MANAGED_BEGIN}\n## Managed instructions (pi-init)\n- A fact.\n${MANAGED_END}`;

test("parent escaping the root through a symlink is refused", () => {
  const root = fs.realpathSync(mkTemp());
  const outside = fs.realpathSync(mkTemp());

  fs.mkdirSync(path.join(outside, "sub"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "mid"));

  const target = path.join(root, "mid", "sub", "AGENTS.md");
  const proposed = `# Project instructions\n\n${BLOCK}\n`;

  const result = validateProposal({
    root,
    targetAbsPath: target,
    proposedContent: proposed,
    existingContent: null,
  });

  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toMatch(/symlink/);
});

test("a plain create inside the root passes validation", () => {
  const root = fs.realpathSync(mkTemp());
  const proposed = `# Project instructions\n\n${BLOCK}\n`;

  const result = validateProposal({
    root,
    targetAbsPath: path.join(root, "AGENTS.md"),
    proposedContent: proposed,
    existingContent: null,
  });

  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
});

test("JSON-quoted secret values are refused", () => {
  const root = fs.realpathSync(mkTemp());
  const proposed = `# Project instructions\n\n${BLOCK}\n{"api_key": "sk-test-123"}\n`;

  const result = validateProposal({
    root,
    targetAbsPath: path.join(root, "AGENTS.md"),
    proposedContent: proposed,
    existingContent: null,
  });

  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toMatch(/secret/);
});

test("NUL bytes are refused", () => {
  const root = fs.realpathSync(mkTemp());
  const proposed = `# Project instructions\n\n${BLOCK}\nbefore\x00after\n`;

  const result = validateProposal({
    root,
    targetAbsPath: path.join(root, "AGENTS.md"),
    proposedContent: proposed,
    existingContent: null,
  });

  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toMatch(/control/);
});

test("token prefixes and bearer credentials are refused and redacted", () => {
  const root = fs.realpathSync(mkTemp());
  const target = path.join(root, "AGENTS.md");

  for (const secret of [
    "ghp_12345678901234567890abcdef",
    "gho_12345678901234567890abcdef",
    "github_pat_12345678901234567890abcdef",
    "AKIAIOSFODNN7EXAMPLE",
    "Bearer abcdefghij1234567890",
    "xoxb-" + "123456789012-abcdefghij1234567890",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ]) {
    const result = validateProposal({
      root,
      targetAbsPath: target,
      proposedContent: `# Project instructions\n\n${BLOCK}\n${secret}\n`,
      existingContent: null,
    });

    expect(result.ok, secret).toBe(false);
    expect(result.errors.join(" "), secret).toMatch(/secret/);
  }
});

test("invisible direction overrides are refused", () => {
  const root = fs.realpathSync(mkTemp());
  const proposed = `# Project instructions\n\n${BLOCK}\nbefore‮after\n`;

  const result = validateProposal({
    root,
    targetAbsPath: path.join(root, "AGENTS.md"),
    proposedContent: proposed,
    existingContent: null,
  });

  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toMatch(/direction overrides/);
});
