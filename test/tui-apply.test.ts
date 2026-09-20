// Real-wire dialog matrix for /init through the real pi binary. RPC mode is
// pi's scriptable TUI surface (ctx.hasUI is true; select/notify travel as
// real dialogs), so answering select requests here is the honest equivalent
// of clicking in the TUI. No module mocking: a real `pi` subprocess loads
// the built dist entry against real temp fixtures. Stub-UI unit tests pin
// the core logic; these tests pin the adapter mapping at the wire: every
// dialog outcome, dialog dismissal, forged answers, read-only modes that
// must never open a dialog, unknown arguments, and the update re-draft flow.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { CHOICES } from "../src/command.js";
import { MANAGED_BEGIN, MANAGED_END } from "../src/facts.js";

// Tests run from the package root (`pnpm test`), so the repo root is
// cwd-relative (same convention as packaging.test.ts).
const REPO = process.cwd();

const PI = "pi";

/** Flat envelope covering exactly the RPC fields this test reads. */
interface RpcWireEvent {
  type: string;
  id?: string;
  command?: string;
  success?: boolean;
  method?: string;
  title?: string;
  options?: string[];
  message?: string;
  data?: { commands?: Array<{ name?: string }> };
}

interface RpcOutbound {
  type: string;
  id?: string;
  message?: string;
  value?: string;
  cancelled?: boolean;
}

function hasPi(): boolean {
  try {
    return spawnSync(PI, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const SKIP_RPC = process.env.PI_INIT_SKIP_RPC === "1" || !hasPi();

function mkTemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixtureProject(): string {
  const dir = mkTemp("pi-init-tui-");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "npm test" } }),
  );
  fs.writeFileSync(path.join(dir, "README.md"), "# Fixture\n\nA real-TUI fixture.\n");

  return dir;
}

interface Waiter {
  pred: (ev: RpcWireEvent) => boolean;
  resolve: (ev: RpcWireEvent) => void;
  reject: (err: Error) => void;
}

/** Minimal JSONL RPC client. Splits on \n only, per the RPC framing rules. */
class Rpc {
  private child: ChildProcess;
  private buffer = "";
  private seen: string[] = [];
  private notes: string[] = [];
  private waiters: Waiter[] = [];

  constructor(cwd: string, home: string) {
    const entry = path.join(REPO, "dist", "src", "extension.js");
    expect(fs.existsSync(entry), "built extension entry must exist (pnpm test runs tsc first)").toBeTruthy();
    this.child = spawn(
      PI,
      ["--mode", "rpc", "--no-session", "--offline", "-e", entry],
      { cwd, env: { ...process.env, HOME: home, PI_OFFLINE: "1" }, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout = this.child.stdout;
    expect(stdout, "rpc child needs piped stdout").toBeTruthy();
    stdout?.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    this.child.on("exit", (code) => this.failAll(`pi exited (${code})`));
    this.child.on("error", (err) => this.failAll(`pi failed to spawn (${err.message})`));
  }

  private failAll(why: string): void {
    const waiters = this.waiters;
    this.waiters = [];

    for (const w of waiters) w.reject(new Error(`${why}; event flow: ${this.seen.join(" ")}`));
  }

  private onData(text: string): void {
    this.buffer += text;

    let cut: number;

    while ((cut = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, cut).replace(/\r$/, "");
      this.buffer = this.buffer.slice(cut + 1);

      if (!line.trim()) continue;
      // SAFETY: pi RPC emits one JSON object per line with a string `type`;
      // predicates below match only documented type/method values, so any
      // unexpected shape degrades to an unmatched, logged flow entry.
      const ev = JSON.parse(line) as RpcWireEvent;
      this.seen.push(ev.method ?? ev.command ?? ev.type);

      if (ev.method === "notify") this.notes.push(ev.message ?? "");
      const hit = this.waiters.filter((w) => w.pred(ev));
      this.waiters = this.waiters.filter((w) => !hit.includes(w));

      for (const w of hit) w.resolve(ev);
    }
  }

  send(message: RpcOutbound): void {
    const stdin = this.child.stdin;
    expect(stdin, "rpc child needs piped stdin").toBeTruthy();
    stdin?.write(`${JSON.stringify(message)}\n`);
  }

  waitFor(pred: (ev: RpcWireEvent) => boolean, label: string, timeoutMs = 90000): Promise<RpcWireEvent> {
    return new Promise<RpcWireEvent>((resolve, reject) => {
      const waiter: Waiter = {
        pred,
        resolve: (ev) => {
          clearTimeout(timer);
          resolve(ev);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };

      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out waiting for ${label}; event flow: ${this.seen.join(" ")}`));
      }, timeoutMs);

      this.waiters.push(waiter);
    });
  }

  /** Ordered flow of matched event kinds, e.g. ["get_commands", "notify", "select"]. */
  flow(): string[] {
    return [...this.seen];
  }

  /** Notify bodies shown so far, in arrival order. */
  shown(): string[] {
    return [...this.notes];
  }

  kill(): void {
    this.child.kill();
  }
}

function startRpc(project: string): Rpc {
  return new Rpc(project, mkTemp("pi-init-tui-home-"));
}

function isSelect(ev: RpcWireEvent): boolean {
  return ev.type === "extension_ui_request" && ev.method === "select";
}

function notifyIncludes(text: string): (ev: RpcWireEvent) => boolean {
  return (ev) =>
    ev.type === "extension_ui_request" && ev.method === "notify" && (ev.message ?? "").includes(text);
}

test(
  "real TUI loop: /init registers, select dialog offers the choices, clicking Apply writes one section",
  { skip: SKIP_RPC, timeout: 120000 },
  async () => {
    const project = fixtureProject();
    const before = fs.readdirSync(project).sort();
    const rpc = startRpc(project);

    try {
      rpc.send({ id: "c1", type: "get_commands" });

      const listed = await rpc.waitFor(
        (ev) => ev.type === "response" && ev.id === "c1",
        "get_commands response",
      );

      expect(listed.success, "get_commands must succeed").toBe(true);
      const names = (listed.data?.commands ?? []).map((c) => c.name);
      expect(names.includes("init"), `real loader must register /init (saw: ${names.join(",")})`).toBeTruthy();

      rpc.send({ id: "p1", type: "prompt", message: "/init" });

      const dialog = await rpc.waitFor(isSelect, "the Apply select dialog");

      expect(dialog.title).toMatch(/^Apply pi-init proposal to AGENTS\.md\?/);
      expect(dialog.options).toEqual(CHOICES.map((c) => c.label));

      // The proposal must be shown before the choice is asked: a notify
      // precedes the select request in the event flow.
      const flow = rpc.flow();
      const notifyAt = flow.indexOf("notify");
      const selectAt = flow.indexOf("select");
      expect(notifyAt >= 0 && selectAt > notifyAt, `proposal shown before choice (flow: ${flow.join(" ")})`).toBeTruthy();

      // The click. Nothing before this point may have written.
      expect(fs.readdirSync(project).sort(), "dialog alone writes nothing").toEqual(before);
      rpc.send({ type: "extension_ui_response", id: dialog.id, value: "Apply" });

      const wrote = await rpc.waitFor(notifyIncludes("Wrote AGENTS.md"), "the Wrote confirmation");

      expect(wrote.message).toMatch(/one managed section/);

      const after = fs.readdirSync(project).sort();
      expect(after.filter((f) => !before.includes(f)), "the click creates exactly AGENTS.md").toEqual([
        "AGENTS.md",
      ]);
      const content = fs.readFileSync(path.join(project, "AGENTS.md"), "utf8");
      expect(content.split(MANAGED_BEGIN).length - 1, "exactly one managed begin").toBe(1);
      expect(content.split(MANAGED_END).length - 1, "exactly one managed end").toBe(1);
      expect(content.includes("npm run test"), "content is evidence-backed, not filler").toBeTruthy();
    } finally {
      rpc.kill();
    }
  },
);

test(
  "real TUI loop: clicking Cancel writes nothing",
  { skip: SKIP_RPC, timeout: 120000 },
  async () => {
    const project = fixtureProject();
    const before = fs.readdirSync(project).sort();
    const rpc = startRpc(project);

    try {
      rpc.send({ id: "p1", type: "prompt", message: "/init" });

      const dialog = await rpc.waitFor(isSelect, "the Cancel select dialog");

      rpc.send({ type: "extension_ui_response", id: dialog.id, value: "Cancel (no write)" });

      const done = await rpc.waitFor(
        notifyIncludes("Cancelled; nothing was written."),
        "the Cancelled confirmation",
      );

      expect(done.message).toMatch(/Cancelled; nothing was written\./);
      expect(fs.readdirSync(project).sort(), "cancelled run writes nothing").toEqual(before);
    } finally {
      rpc.kill();
    }
  },
);

test(
  "real TUI loop: clicking Copy/print shows the draft and writes nothing",
  { skip: SKIP_RPC, timeout: 120000 },
  async () => {
    const project = fixtureProject();
    const before = fs.readdirSync(project).sort();
    const rpc = startRpc(project);

    try {
      rpc.send({ id: "p1", type: "prompt", message: "/init" });

      const dialog = await rpc.waitFor(isSelect, "the Copy select dialog");

      rpc.send({ type: "extension_ui_response", id: dialog.id, value: "Copy/print draft (no write)" });

      const done = await rpc.waitFor(
        notifyIncludes("Draft shown above; nothing was written."),
        "the Draft confirmation",
      );

      expect(done.message).toMatch(/Draft shown above; nothing was written\./);
      expect(fs.readdirSync(project).sort(), "copy run writes nothing").toEqual(before);

      // The copy path shows the full draft through a second notify: the
      // managed block must have crossed the wire.
      expect(
        rpc.shown().some((body) => body.includes(MANAGED_BEGIN)),
        "draft content shown above the confirmation",
      ).toBeTruthy();
    } finally {
      rpc.kill();
    }
  },
);

test(
  "real TUI loop: dismissing the dialog writes nothing",
  { skip: SKIP_RPC, timeout: 120000 },
  async () => {
    const project = fixtureProject();
    const before = fs.readdirSync(project).sort();
    const rpc = startRpc(project);

    try {
      rpc.send({ id: "p1", type: "prompt", message: "/init" });

      const dialog = await rpc.waitFor(isSelect, "the dismissed select dialog");

      // No value, cancelled: the timeout/close path through the real wire.
      rpc.send({ type: "extension_ui_response", id: dialog.id, cancelled: true });

      const done = await rpc.waitFor(
        notifyIncludes("Cancelled; nothing was written."),
        "the Cancelled confirmation",
      );

      expect(done.message).toMatch(/Cancelled; nothing was written\./);
      expect(fs.readdirSync(project).sort(), "dismissed run writes nothing").toEqual(before);
    } finally {
      rpc.kill();
    }
  },
);

test(
  "real TUI loop: a forged dialog answer writes nothing",
  { skip: SKIP_RPC, timeout: 120000 },
  async () => {
    const project = fixtureProject();
    const before = fs.readdirSync(project).sort();
    const rpc = startRpc(project);

    try {
      rpc.send({ id: "p1", type: "prompt", message: "/init" });

      const dialog = await rpc.waitFor(isSelect, "the forged select dialog");

      // An answer outside the offered labels must never resolve to a choice.
      rpc.send({ type: "extension_ui_response", id: dialog.id, value: "Bogus" });

      const done = await rpc.waitFor(
        notifyIncludes("Cancelled; nothing was written."),
        "the Cancelled confirmation",
      );

      expect(done.message).toMatch(/Cancelled; nothing was written\./);
      expect(fs.readdirSync(project).sort(), "forged answer writes nothing").toEqual(before);
    } finally {
      rpc.kill();
    }
  },
);

test(
  "real TUI loop: /init audit is read-only and never opens a dialog",
  { skip: SKIP_RPC, timeout: 120000 },
  async () => {
    const project = fixtureProject();
    const before = fs.readdirSync(project).sort();
    const rpc = startRpc(project);

    try {
      rpc.send({ id: "p1", type: "prompt", message: "/init audit" });

      const done = await rpc.waitFor(
        notifyIncludes("Audit shown above; nothing was written."),
        "the Audit confirmation",
      );

      expect(done.message).toMatch(/Audit shown above; nothing was written\./);

      // The final notify is the handler's last UI call, so a flow without
      // select proves no dialog was ever opened.
      expect(rpc.flow().includes("select"), `audit must never open a dialog (flow: ${rpc.flow().join(" ")})`).toBe(false);
      expect(fs.readdirSync(project).sort(), "audit writes nothing").toEqual(before);
    } finally {
      rpc.kill();
    }
  },
);

test(
  "real TUI loop: /init status is read-only and never opens a dialog",
  { skip: SKIP_RPC, timeout: 120000 },
  async () => {
    const project = fixtureProject();
    const before = fs.readdirSync(project).sort();
    const rpc = startRpc(project);

    try {
      rpc.send({ id: "p1", type: "prompt", message: "/init status" });

      const done = await rpc.waitFor(
        notifyIncludes("Status shown above; nothing was written."),
        "the Status confirmation",
      );

      expect(done.message).toMatch(/Status shown above; nothing was written\./);
      expect(rpc.flow().includes("select"), `status must never open a dialog (flow: ${rpc.flow().join(" ")})`).toBe(false);
      expect(fs.readdirSync(project).sort(), "status writes nothing").toEqual(before);
    } finally {
      rpc.kill();
    }
  },
);

test(
  "real TUI loop: /init with an unknown argument explains usage without a dialog",
  { skip: SKIP_RPC, timeout: 120000 },
  async () => {
    const project = fixtureProject();
    const before = fs.readdirSync(project).sort();
    const rpc = startRpc(project);

    try {
      rpc.send({ id: "p1", type: "prompt", message: "/init frobnicate" });

      const done = await rpc.waitFor(
        notifyIncludes('Unknown argument "frobnicate"'),
        "the usage message",
      );

      expect(done.message).toMatch(/Usage: \/init \[update\|audit\|status\]/);
      expect(rpc.flow().includes("select"), `unknown args must never open a dialog (flow: ${rpc.flow().join(" ")})`).toBe(false);
      expect(fs.readdirSync(project).sort(), "unknown args write nothing").toEqual(before);
    } finally {
      rpc.kill();
    }
  },
);

test(
  "real TUI loop: /init update re-drafts after a manifest change and Apply writes it",
  { skip: SKIP_RPC, timeout: 180000 },
  async () => {
    const project = fixtureProject();
    const rpc = startRpc(project);

    try {
      rpc.send({ id: "p1", type: "prompt", message: "/init" });

      const first = await rpc.waitFor(isSelect, "the first select dialog");

      rpc.send({ type: "extension_ui_response", id: first.id, value: "Apply" });

      await rpc.waitFor(notifyIncludes("Wrote AGENTS.md"), "the first Wrote confirmation");

      const target = path.join(project, "AGENTS.md");
      const v1 = fs.readFileSync(target, "utf8");
      expect(v1.includes("Lint:"), "first draft has no lint evidence yet").toBe(false);

      // Change the evidence, then re-run the flow in the same session.
      fs.writeFileSync(
        path.join(project, "package.json"),
        JSON.stringify({ name: "fixture", scripts: { test: "npm test", lint: "eslint ." } }),
      );

      rpc.send({ id: "p2", type: "prompt", message: "/init update" });

      const second = await rpc.waitFor(isSelect, "the update select dialog");

      expect(second.title).toMatch(/^Apply pi-init proposal to AGENTS\.md\?/);
      rpc.send({ type: "extension_ui_response", id: second.id, value: "Apply" });

      await rpc.waitFor(notifyIncludes("Wrote AGENTS.md"), "the second Wrote confirmation");

      const v2 = fs.readFileSync(target, "utf8");
      expect(v2.includes("Lint: `npm run lint`"), "updated draft carries the new evidence").toBeTruthy();
      expect(v2.includes("npm run test"), "updated draft keeps the old evidence").toBeTruthy();
      expect(v2.split(MANAGED_BEGIN).length - 1, "still exactly one managed begin").toBe(1);
      expect(v2.split(MANAGED_END).length - 1, "still exactly one managed end").toBe(1);
    } finally {
      rpc.kill();
    }
  },
);
