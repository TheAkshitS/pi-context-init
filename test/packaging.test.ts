// Ticket 06: packaging and quality gates. What gets tested is the packed
// artifact, not the source tree: pack the tarball, assert its contents,
// then load its extension entry and run the no-write/apply/audit paths
// against fixture projects using only the verified public Pi API shape
// (pi.registerCommand), so Pi drift fails loudly.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { pathToFileURL } from "node:url";

// Tests run from the package root (`pnpm test`), so the repo root is cwd-relative
// (same convention as no-llm-path.test.ts). `__dirname` is unavailable under vitest's ESM
// transform and `import.meta` is illegal in the tsc CJS build, so neither is used here.
const REPO = process.cwd();

interface StubUi {
  notify(message: string): void;
  select(title: string, options: string[]): Promise<string | undefined>;
}

interface StubCtx {
  cwd: string;
  hasUI: boolean;
  ui: StubUi;
}

type InitHandler = (args: string, ctx: StubCtx) => Promise<void>;

interface CapturedCommand {
  name: string;
  handler: InitHandler;
}

interface PiManifestField {
  extensions: string[];
  skills: string[];
}

interface PackageManifest {
  description: string;
  keywords: string[];
  license: string;
  pi: PiManifestField;
  scripts?: { prepare?: string; prepack?: string };
}

interface FakePi {
  registerCommand(name: string, options: { handler: InitHandler }): void;
}

type ExtensionFactory = (pi: FakePi) => void;

function readManifest(): PackageManifest {
  const raw = fs.readFileSync(path.join(REPO, "package.json"), "utf8");
  // SAFETY: package.json is repo-controlled; field presence is asserted by callers.
  const parsed = JSON.parse(raw) as Partial<PackageManifest>;
  expect(parsed.description, "package.json needs a description").toBeTruthy();
  expect(Array.isArray(parsed.keywords) && parsed.keywords.includes("pi-package"), "package.json needs the pi-package keyword for gallery discovery").toBeTruthy();
  expect(parsed.license, "license field must match the LICENSE file").toBe("MIT");
  expect(parsed.pi, "package.json needs the pi install manifest").toBeTruthy();
  expect(Array.isArray(parsed.pi?.extensions) && (parsed.pi?.extensions?.length ?? 0) > 0, "pi.extensions required").toBeTruthy();
  expect(Array.isArray(parsed.pi?.skills) && (parsed.pi?.skills?.length ?? 0) > 0, "pi.skills required").toBeTruthy();
  expect(parsed.scripts?.prepare ?? "", "need prepare:tsc so git clones build dist (pi only runs npm install)").toContain("tsc");

  // SAFETY: every field above was asserted present with the right container type.
  return parsed as PackageManifest;
}

function mkTemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Pack the repo exactly as npm would publish it; return the tarball path. */
function packTarball(dest: string): string {
  execFileSync("npm", ["pack", "--pack-destination", dest, "--silent"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tgz = fs.readdirSync(dest).filter((f) => f.endsWith(".tgz"));
  expect(tgz.length, `expected one tarball, found ${tgz.join(",")}`).toBe(1);

  return path.join(dest, tgz[0]);
}

function tarList(tgz: string): string[] {
  const out = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" });

  return out.split("\n").filter((l) => l.length > 0);
}

/** Load the packed extension entry; only files from the tarball are visible. */
async function loadPackedFactory(tgz: string): Promise<ExtensionFactory> {
  const dir = mkTemp("pi-init-packed-");
  execFileSync("tar", ["-xzf", tgz, "-C", dir]);
  const entry = path.join(dir, "package", "dist", "src", "extension.js");
  expect(fs.existsSync(entry), "packed tarball must contain the built entry").toBeTruthy();
  // SAFETY: file URL is built from the just-extracted tarball path above.
  const loaded = (await import(pathToFileURL(entry).href)) as { default?: unknown };
  // Mirror the loader's default interop: tsc ESM emits `{default: factory}`,
  // so unwrap one level when needed.
  const exported = loaded.default ?? loaded;

  // SAFETY: non-function exports objects carry the factory under `.default` (tsc ESM shape).
  const candidate =
    exported instanceof Function ? exported : (exported as { default?: unknown }).default;

  expect(candidate instanceof Function, "entry must default-export the factory").toBeTruthy();

  // SAFETY: instanceof narrows to Function; registration below proves the call signature.
  return candidate as ExtensionFactory;
}

function registerFactory(factory: ExtensionFactory): CapturedCommand[] {
  const seen: CapturedCommand[] = [];
  factory({
    registerCommand(name: string, options: { handler: InitHandler }) {
      expect(options.handler instanceof Function, "registered command needs a handler").toBeTruthy();
      seen.push({ name, handler: options.handler });
    },
  });

  return seen;
}

test("package manifest declares the pi install contract", () => {
  const pkg = readManifest();
  expect(fs.readFileSync(path.join(REPO, "LICENSE"), "utf8").includes("MIT License"), "LICENSE file must exist and agree").toBeTruthy();

  for (const entry of pkg.pi.extensions) {
    expect(fs.existsSync(path.join(REPO, entry)), `built extension entry must exist on disk: ${entry}`).toBeTruthy();
  }

  for (const dir of pkg.pi.skills) {
    const skill = path.join(REPO, dir, "repository-analysis", "SKILL.md");
    expect(fs.existsSync(skill), `bundled skill must exist: ${skill}`).toBeTruthy();
    const front = fs.readFileSync(skill, "utf8");
    expect(front, "skill needs a valid name").toMatch(/^name: [a-z0-9-]+$/m);
    expect(front, "skill needs a description").toMatch(/^description: .+$/m);
  }
});

test("packed tarball contains the runtime and excludes the workroom", () => {
  const tgz = packTarball(mkTemp("pi-init-pack-"));
  const files = tarList(tgz);

  for (const want of [
    "package/dist/src/extension.js",
    "package/skills/repository-analysis/SKILL.md",
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/CHANGELOG.md",
  ]) {
    expect(files.includes(want), `tarball must contain ${want}`).toBeTruthy();
  }

  for (const f of files) {
    expect(!f.includes(".scratch"), `tarball must not contain workroom: ${f}`).toBeTruthy();
    expect(!f.includes("node_modules"), `tarball must not bundle modules: ${f}`).toBeTruthy();
    expect(!f.startsWith("package/src/"), `tarball ships compiled output, not src: ${f}`).toBeTruthy();
    expect(!f.startsWith("package/dist/test/"), `tarball omits tests: ${f}`).toBeTruthy();
    expect(!f.endsWith(".env"), `tarball must not contain env files: ${f}`).toBeTruthy();
  }
});

test("packed extension registers /init and fails closed without the API", async () => {
  const tgz = packTarball(mkTemp("pi-init-pack-"));
  const factory = await loadPackedFactory(tgz);
  const seen = registerFactory(factory);
  expect(seen.length, "exactly one command registered").toBe(1);
  expect(seen[0].name).toBe("init");

  expect(// SAFETY: {} lacks registerCommand on purpose; the factory must reject it.
    () => factory({} as FakePi), "missing registerCommand must fail with the actionable version message").toThrow(/pi >= 0\.85\.1/);
});

function fixtureProject(): string {
  const dir = mkTemp("pi-init-e2e-");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "npm test" } }),
  );
  fs.writeFileSync(path.join(dir, "README.md"), "# Fixture\n\nA packed-artifact fixture.\n");

  return dir;
}

function ctxFor(dir: string, picked: string | undefined, log: string[]): StubCtx {
  return {
    cwd: dir,
    hasUI: true,
    ui: {
      notify: (message: string): void => {
        log.push(message);
      },
      select: async (): Promise<string | undefined> => picked,
    },
  };
}

function countMarkers(content: string): number {
  return (
    content.split("<!-- pi-init:begin -->").length - 1 +
    (content.split("<!-- pi-init:end -->").length - 1)
  );
}

test("packed artifact end-to-end: cancel writes nothing, apply writes one section, audit is read-only", async () => {
  const tgz = packTarball(mkTemp("pi-init-pack-"));
  const seen = registerFactory(await loadPackedFactory(tgz));
  expect(seen.length).toBe(1);
  const init = seen[0].handler;

  const project = fixtureProject();
  const before = fs.readdirSync(project).sort();

  await init("", ctxFor(project, undefined, []));
  expect(fs.readdirSync(project).sort(), "cancelled run writes nothing").toEqual(before);

  await init("audit", ctxFor(project, undefined, []));
  expect(fs.readdirSync(project).sort(), "audit writes nothing").toEqual(before);

  await init("", ctxFor(project, "Apply", []));
  const target = path.join(fs.realpathSync(project), "AGENTS.md");
  expect(fs.existsSync(target), "approved run creates AGENTS.md").toBeTruthy();
  const content = fs.readFileSync(target, "utf8");
  expect(countMarkers(content), "exactly one managed section").toBe(2);
  expect(content.includes("npm run test"), "content is evidence-backed, not filler").toBeTruthy();
});
