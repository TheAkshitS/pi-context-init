import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { isWithinRoot, resolveRoot } from "../src/root.js";

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-init-root-"));
}

test("non-git directory resolves to itself with cwd source", () => {
  const dir = mkTemp();
  const resolved = resolveRoot(dir, () => null);
  expect(resolved.root).toBe(fs.realpathSync(dir));
  expect(resolved.rootSource).toBe("cwd");
});

test("git failure falls back to the start directory", () => {
  const dir = mkTemp();

  const resolved = resolveRoot(dir, () => {
    throw new Error("no git");
  });

  expect(resolved.root).toBe(fs.realpathSync(dir));
  expect(resolved.rootSource).toBe("cwd");
});

test("git top level outside the start directory is rejected", () => {
  const dir = mkTemp();
  const resolved = resolveRoot(dir, () => "/elsewhere/entirely");
  expect(resolved.root).toBe(fs.realpathSync(dir));
  expect(resolved.rootSource).toBe("cwd");
});

test(
  "nested start directory resolves to the git root",
  { skip: process.env.PI_INIT_SKIP_GIT ? true : false },
  () => {
    const dir = mkTemp();

    const run = (args: string[], cwd: string): void => {
      const out = spawnSync("git", args, { cwd, stdio: "ignore" });
      expect(out.status, `git ${args.join(" ")} failed`).toBe(0);
    };

    run(["init"], dir);
    const nested = path.join(dir, "packages", "a");
    fs.mkdirSync(nested, { recursive: true });
    const resolved = resolveRoot(nested);
    expect(resolved.root).toBe(fs.realpathSync(dir));
    expect(resolved.rootSource).toBe("git");
  },
);

test("containment accepts the root and insides, rejects escapes and siblings", () => {
  const root = path.resolve(mkTemp());
  expect(isWithinRoot(root, root)).toBeTruthy();
  expect(isWithinRoot(root, path.join(root, "sub", "AGENTS.md"))).toBeTruthy();
  expect(!isWithinRoot(root, path.join(root, "..", "sibling", "AGENTS.md"))).toBeTruthy();
  expect(!isWithinRoot(root, "/etc/passwd")).toBeTruthy();
});

test("containment does not misread dotdot-prefixed inside names", () => {
  const root = path.resolve(mkTemp());
  expect(isWithinRoot(root, path.join(root, "..foo", "AGENTS.md"))).toBeTruthy();
  expect(isWithinRoot(root, path.join(root, "...", "AGENTS.md"))).toBeTruthy();
  expect(!isWithinRoot(root, path.join(root, ".."))).toBeTruthy();
});
