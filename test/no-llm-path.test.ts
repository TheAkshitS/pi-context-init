import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "vitest";

// Ticket 07 gate: Pi 0.85.1 exposes no documented one-shot LLM API for
// extensions, so refinement is omitted and the deterministic draft is the
// only path. These tests fail closed if anyone adds a model or network
// call to the core: no payload may cross an LLM boundary that was never
// approved.
// Tests run from the package root (`pnpm test`), so the source tree is cwd-relative.
const SRC = path.resolve("src");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) return sources(full);

    return full.endsWith(".ts") ? [full] : [];
  });
}

const FORBIDDEN: RegExp[] = [
  /\bfetch\s*\(/,
  /sendUserMessage/,
  /\bsendMessage\s*\(/,
  /completeSimple/,
  /model-runtime/,
  /https?:\/\//,
  /node:https?/,
  /\bWebSocket\b/,
];

test("no refinement module exists; the deterministic draft is the only path", () => {
  const files = sources(SRC);

  expect(files.length > 0, "expected to find TypeScript sources under src/").toBeTruthy();
  expect(!files.some((f) => path.basename(f) === "refine.ts"), "src/refine.ts must not exist while ticket 07 stays omitted").toBeTruthy();
});

test("no model invocation or network call in the core", () => {
  for (const file of sources(SRC)) {
    const text = fs.readFileSync(file, "utf8");

    for (const pattern of FORBIDDEN) {
      expect(!pattern.test(text), `${path.relative(SRC, file)} matches forbidden ${pattern} (ticket 07: no LLM boundary)`).toBeTruthy();
    }
  }
});
