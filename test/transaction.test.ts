import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { MANAGED_BEGIN, MANAGED_END } from "../src/facts.js";
import { applyWrite, WriteConflictError } from "../src/transaction.js";
import { hashContent } from "../src/validate.js";

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-init-txn-"));
}

const PROPOSED = `# Project instructions\n\n${MANAGED_BEGIN}\n## Managed instructions (pi-init)\n- A fact.\n${MANAGED_END}\n`;

test("apply creates the target with exact content and no temp residue", () => {
  const dir = fs.realpathSync(mkTemp());
  const target = path.join(dir, "AGENTS.md");

  const result = applyWrite({
    targetAbsPath: target,
    proposedContent: PROPOSED,
    baseHash: hashContent(null),
    root: dir,
  });

  expect(result.path).toBe(target);
  expect(fs.readFileSync(target, "utf8")).toBe(PROPOSED);
  expect(fs.readdirSync(dir)).toEqual(["AGENTS.md"]);
});

test("apply replaces an unchanged target", () => {
  const dir = fs.realpathSync(mkTemp());
  const target = path.join(dir, "AGENTS.md");
  const original = `# Project instructions\n\n${MANAGED_BEGIN}\nold\n${MANAGED_END}\n`;
  fs.writeFileSync(target, original);

  const result = applyWrite({
    targetAbsPath: target,
    proposedContent: PROPOSED,
    baseHash: hashContent(original),
    root: dir,
  });

  expect(result.path).toBe(target);
  expect(fs.readFileSync(target, "utf8")).toBe(PROPOSED);
});

test("target changed since preview aborts atomically", () => {
  const dir = fs.realpathSync(mkTemp());
  const target = path.join(dir, "AGENTS.md");
  const previewed = `# Manual\n\n${MANAGED_BEGIN}\nold\n${MANAGED_END}\n`;
  fs.writeFileSync(target, previewed);
  const tampered = `${previewed}\nSomeone edited this.\n`;
  fs.writeFileSync(target, tampered);

  let thrown: unknown;

  try {
    applyWrite({
      targetAbsPath: target,
      proposedContent: PROPOSED,
      baseHash: hashContent(previewed),
      root: dir,
    });
  } catch (error) {
    thrown = error;
  }

  if (!(thrown instanceof WriteConflictError)) {
    expect.unreachable(`expected WriteConflictError, got ${String(thrown)}`);
  }

  expect(thrown.message).toMatch(/Rerun \/init/);
  expect(fs.readFileSync(target, "utf8")).toBe(tampered);
  expect(fs.readdirSync(dir)).toEqual(["AGENTS.md"]);
});

test("create conflicts when the target appeared after preview", () => {
  const dir = fs.realpathSync(mkTemp());
  const target = path.join(dir, "AGENTS.md");
  fs.writeFileSync(target, "appeared\n");
  expect(() =>
      applyWrite({ targetAbsPath: target, proposedContent: PROPOSED, baseHash: hashContent(null), root: dir })).toThrow(WriteConflictError);
  expect(fs.readFileSync(target, "utf8")).toBe("appeared\n");
});

test("apply with root succeeds inside the root", () => {
  const dir = fs.realpathSync(mkTemp());
  const target = path.join(dir, "AGENTS.md");

  const result = applyWrite({
    targetAbsPath: target,
    proposedContent: PROPOSED,
    baseHash: hashContent(null),
    root: dir,
  });

  expect(result.path).toBe(target);
  expect(fs.readFileSync(target, "utf8")).toBe(PROPOSED);
});

test("symlinked parent aborts when root is provided", () => {
  const root = fs.realpathSync(mkTemp());
  const outside = fs.realpathSync(mkTemp());
  fs.mkdirSync(path.join(outside, "sub"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "mid"));

  const target = path.join(root, "mid", "sub", "AGENTS.md");

  expect(() =>
    applyWrite({
      targetAbsPath: target,
      proposedContent: PROPOSED,
      baseHash: hashContent(null),
      root,
    })).toThrow(WriteConflictError);
  expect(fs.existsSync(target)).toBe(false);
});

test("vanished parent aborts when root is provided", () => {
  const root = fs.realpathSync(mkTemp());
  const dir = path.join(root, "gone");
  fs.mkdirSync(dir);
  const target = path.join(dir, "AGENTS.md");
  fs.rmSync(dir, { recursive: true });

  expect(() =>
    applyWrite({
      targetAbsPath: target,
      proposedContent: PROPOSED,
      baseHash: hashContent(null),
      root,
    })).toThrow(WriteConflictError);
});

test("writer re-validation refuses secrets even when the caller skips validation", () => {
  const dir = fs.realpathSync(mkTemp());
  const target = path.join(dir, "AGENTS.md");

  expect(() =>
    applyWrite({
      targetAbsPath: target,
      proposedContent: `${PROPOSED}api_key = hunter2-value\n`,
      baseHash: hashContent(null),
      root: dir,
    })).toThrow(WriteConflictError);
  expect(fs.existsSync(target)).toBe(false);
});

test("symlink swapped in after preview aborts instead of writing through", () => {
  const dir = fs.realpathSync(mkTemp());
  const target = path.join(dir, "AGENTS.md");
  const original = `# Project instructions\n\n${MANAGED_BEGIN}\nold\n${MANAGED_END}\n`;
  fs.writeFileSync(target, original);
  const outside = path.join(fs.realpathSync(mkTemp()), "real.md");
  fs.writeFileSync(outside, "# Real\n");
  fs.rmSync(target);
  fs.symlinkSync(outside, target);

  expect(() =>
    applyWrite({ targetAbsPath: target, proposedContent: PROPOSED, baseHash: hashContent(original), root: dir })).toThrow(
      WriteConflictError,
    );
  expect(fs.readFileSync(outside, "utf8")).toBe("# Real\n");
});

test("existing file mode is preserved instead of flipping to 0600", () => {
  const dir = fs.realpathSync(mkTemp());
  const target = path.join(dir, "AGENTS.md");
  const original = `# Project instructions\n\n${MANAGED_BEGIN}\nold\n${MANAGED_END}\n`;
  fs.writeFileSync(target, original, { mode: 0o644 });

  applyWrite({ targetAbsPath: target, proposedContent: PROPOSED, baseHash: hashContent(original), root: dir });

  expect(fs.statSync(target).mode & 0o777).toBe(0o644);
  expect(fs.readFileSync(target, "utf8")).toBe(PROPOSED);
});
