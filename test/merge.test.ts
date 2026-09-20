import { expect, test } from "vitest";
import { MANAGED_BEGIN, MANAGED_END } from "../src/facts.js";
import { buildProposal, checkMarkers } from "../src/merge.js";

const BLOCK = `${MANAGED_BEGIN}\n## Managed instructions (pi-init)\n- A fact.\n${MANAGED_END}`;

test("create composes a header plus the managed block", () => {
  const result = buildProposal(null, BLOCK);
  expect(result.ok).toBe(true);

  if (!result.ok) return;
  expect(result.mode).toBe("create");
  expect(result.content.startsWith("# Project instructions\n\n")).toBeTruthy();
  expect(result.content.split(MANAGED_BEGIN).length - 1).toBe(1);
  expect(result.content.split(MANAGED_END).length - 1).toBe(1);
});

test("append preserves user bytes and adds exactly one section", () => {
  const existing = "# Manual notes\n\nKeep this.\n";
  const result = buildProposal(existing, BLOCK);
  expect(result.ok).toBe(true);

  if (!result.ok) return;
  expect(result.mode).toBe("append");
  expect(result.content.startsWith(existing)).toBeTruthy();
  expect(result.content.includes(BLOCK)).toBeTruthy();
});

test("append without trailing newline still separates cleanly", () => {
  const existing = "# Manual notes";
  const result = buildProposal(existing, BLOCK);
  expect(result.ok).toBe(true);

  if (!result.ok) return;
  expect(result.content.startsWith(existing)).toBeTruthy();
  expect(result.content.includes(`\n\n${BLOCK}\n`)).toBeTruthy();
});

test("append to an empty existing file starts at the managed block", () => {
  const result = buildProposal("", BLOCK);
  expect(result.ok).toBe(true);

  if (!result.ok) return;
  expect(result.mode).toBe("append");
  expect(result.content.startsWith(MANAGED_BEGIN)).toBeTruthy();
  expect(result.content.endsWith(`${MANAGED_END}\n`)).toBeTruthy();
});

test("replace swaps only the managed section", () => {
  const existing = `Top.\n${MANAGED_BEGIN}\nold\n${MANAGED_END}\nBottom.\n`;
  const result = buildProposal(existing, BLOCK);
  expect(result.ok).toBe(true);

  if (!result.ok) return;
  expect(result.mode).toBe("replace");
  expect(result.content.startsWith("Top.\n")).toBeTruthy();
  expect(result.content.endsWith("Bottom.\n")).toBeTruthy();
  expect(result.content.includes(BLOCK)).toBeTruthy();
  expect(!result.content.includes("old")).toBeTruthy();
});

const malformedCases: Array<[string, string]> = [
  ["missing end", `x\n${MANAGED_BEGIN}\nno end\n`],
  ["missing begin", `x\n${MANAGED_END}\n`],
  ["duplicated", `${BLOCK}\n${BLOCK}\n`],
  ["reversed", `${MANAGED_END}\n${MANAGED_BEGIN}\n`],
];

for (const [name, existing] of malformedCases) {
  test(`malformed markers refuse the write: ${name}`, () => {
    expect(checkMarkers(existing).ok).toBe(false);
    const result = buildProposal(existing, BLOCK);
    expect(result.ok).toBe(false);

    if (result.ok) return;
    expect(result.error).toMatch(/marker/i);
  });
}
