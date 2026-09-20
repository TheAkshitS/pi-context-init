// End-to-end acceptance for ticket 02: baseline /init in empty/non-git
// directories, all cancel paths, override safety, conflict abort, nesting.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { CHOICES, runInit, type Choice, type InteractionPort } from "../src/command.js";
import { MANAGED_BEGIN, MANAGED_END } from "../src/facts.js";

/** Test-only stand-in for a UI returning an option outside the known set. */
interface BogusChoice {
  id: string;
  label: string;
}

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-init-cmd-"));
}

function stubUi(log: string[], scripted: Choice | undefined): InteractionPort {
  return {
    show: async (text: string): Promise<void> => {
      log.push(text);
    },
    choose: async (title: string, _options: readonly Choice[]): Promise<Choice | undefined> => {
      log.push(`CHOOSE: ${title}`);

      return scripted;
    },
  };
}

const APPLY = CHOICES[0];

const COPY = CHOICES[1];

const CANCEL = CHOICES[2];

function countMarkers(content: string): number {
  return content.split(MANAGED_BEGIN).length - 1 + (content.split(MANAGED_END).length - 1);
}

test("apply in an empty dir creates AGENTS.md with one managed section", async () => {
  const dir = mkTemp();
  const log: string[] = [];
  const result = await runInit(dir, "", stubUi(log, APPLY), { gitTopLevel: () => null });
  expect(result.wrote).toBe(true);
  const target = path.join(fs.realpathSync(dir), "AGENTS.md");
  expect(result.path).toBe(target);
  const content = fs.readFileSync(target, "utf8");
  expect(content.split(MANAGED_BEGIN).length - 1).toBe(1);
  expect(content.split(MANAGED_END).length - 1).toBe(1);
  expect(content).toMatch(/Evidence was limited/);
  // Target stated before confirmation: a show() precedes the choose().
  const chooseAt = log.findIndex((line) => line.startsWith("CHOOSE:"));
  expect(chooseAt > 0).toBeTruthy();
  expect(log.slice(0, chooseAt).join("\n")).toMatch(/Target: AGENTS\.md \(create\)/);
});

test("cancel, close, and copy paths write nothing", async () => {
  for (const scripted of [CANCEL, undefined]) {
    const dir = mkTemp();
    const result = await runInit(dir, "", stubUi([], scripted), { gitTopLevel: () => null });
    expect(result.wrote).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  }

  const copyDir = mkTemp();
  const copyLog: string[] = [];
  const copyResult = await runInit(copyDir, "", stubUi(copyLog, COPY), { gitTopLevel: () => null });
  expect(copyResult.wrote).toBe(false);
  expect(fs.readdirSync(copyDir)).toEqual([]);
  expect(copyLog.length >= 2, "copy path shows the draft").toBeTruthy();
});

test("unknown arguments and unrecognized choices write nothing", async () => {
  const dir = mkTemp();
  const result = await runInit(dir, "frobnicate", stubUi([], APPLY), { gitTopLevel: () => null });
  expect(result.wrote).toBe(false);
  expect(result.message).toMatch(/Usage/);
  expect(fs.readdirSync(dir)).toEqual([]);

  const bogusDir = mkTemp();
  const bogusInput: BogusChoice = { id: "bogus", label: "Bogus" };

  // SAFETY: downcast only; runInit treats any non-listed id as cancel and writes nothing.
  const bogusChoice = bogusInput as Choice;

  const bogus = await runInit(bogusDir, "", stubUi([], bogusChoice), {
    gitTopLevel: () => null,
  });

  expect(bogus.wrote).toBe(false);
  expect(fs.readdirSync(bogusDir)).toEqual([]);
});

test("override file is never auto-created or overwritten", async () => {
  const dir = mkTemp();
  const overridePath = path.join(dir, "AGENTS.override.md");
  fs.writeFileSync(overridePath, "# Owner rules\n");
  const log: string[] = [];
  const result = await runInit(dir, "", stubUi(log, APPLY), { gitTopLevel: () => null });
  expect(result.wrote).toBe(true);
  expect(result.path).toBe(path.join(fs.realpathSync(dir), "AGENTS.md"));
  expect(fs.readFileSync(overridePath, "utf8")).toBe("# Owner rules\n");
  expect(log.join("\n")).toMatch(/override/i);
});

test("target modified between preview and apply aborts with a rerun message", async () => {
  const dir = mkTemp();
  const target = path.join(dir, "AGENTS.md");
  fs.writeFileSync(target, "# Manual\n");

  const tamperingUi: InteractionPort = {
    show: async (): Promise<void> => {},
    choose: async (): Promise<Choice | undefined> => {
      fs.writeFileSync(target, "# Manual\n\nTampered between preview and apply.\n");

      return APPLY;
    },
  };

  const result = await runInit(dir, "", tamperingUi, { gitTopLevel: () => null });
  expect(result.wrote).toBe(false);
  expect(result.message).toMatch(/Rerun \/init/);
  expect(fs.readFileSync(target, "utf8")).toBe("# Manual\n\nTampered between preview and apply.\n");
});

test(
  "nested start analyzes the git root without touching surroundings",
  { skip: process.env.PI_INIT_SKIP_GIT ? true : false },
  async () => {
    const outer = mkTemp();

    const run = (args: string[], cwd: string): void => {
      const out = spawnSync("git", args, { cwd, stdio: "ignore" });
      expect(out.status, `git ${args.join(" ")} failed`).toBe(0);
    };

    run(["init"], outer);
    const nested = path.join(outer, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    const log: string[] = [];
    const result = await runInit(nested, "", stubUi(log, APPLY));
    expect(result.wrote).toBe(true);
    expect(result.path).toBe(path.join(fs.realpathSync(outer), "AGENTS.md"));
    expect(fs.readdirSync(nested)).toEqual([]);
    expect(!fs.existsSync(path.join(outer, "packages", "AGENTS.md"))).toBeTruthy();
  },
);

test("symlink target refuses the write", async () => {
  const dir = mkTemp();
  const real = path.join(dir, "real.md");
  fs.writeFileSync(real, "# Real\n");
  fs.symlinkSync(real, path.join(dir, "AGENTS.md"));
  const result = await runInit(dir, "", stubUi([], APPLY), { gitTopLevel: () => null });
  expect(result.wrote).toBe(false);
  expect(result.message).toMatch(/symlink/i);
  expect(fs.readFileSync(real, "utf8")).toBe("# Real\n");
});

test("marker count helper sanity: created file holds exactly one pair", async () => {
  const dir = mkTemp();
  const result = await runInit(dir, "", stubUi([], APPLY), { gitTopLevel: () => null });
  expect(result.wrote).toBe(true);
  const content = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  expect(countMarkers(content)).toBe(2);
});
