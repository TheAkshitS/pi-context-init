# Pi API verification gate: Phase 0 decision

Target Pi version: **0.85.1** (`pi --version`, package
`@earendil-works/pi-coding-agent`).

You read these doc sources from a local install of 0.85.1 (same content as the spec's
pinned links):

- packages: `docs/packages.md`: `pi install npm:<package>`, manifest `pi`
  key, convention dirs, `peerDependencies: "*"` for pi core packages.
- extensions: `docs/extensions.md`: entry point, `pi.registerCommand`,
  `ctx.ui`, `CONFIG_DIR_NAME`, jiti TS loading.
- usage: `docs/usage.md`: slash commands, context-file discovery and
  precedence, project trust, `pi install/remove/list/update/config`.
- skills: `docs/skills.md`: skill locations, `SKILL.md` frontmatter,
  `/skill:name` commands, `enableSkillCommands`.

## Exact signatures used (all confirmed in docs + `dist/*.d.ts`)

Entry point: default-export factory, sync or async (`types.d.ts:1159`):

```ts
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

Command registration (`types.d.ts:946`, `891-900`):

```ts
pi.registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
interface RegisteredCommand {
  name: string;
  sourceInfo: SourceInfo;
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}
interface ResolvedCommand extends RegisteredCommand {
  invocationName: string; // actual name after collision handling
}
```

Parse `args: string` in a single `/init` handler. Treat subcommand
completion through `getArgumentCompletions` as optional enhancement.

UI: `ExtensionUIContext` (`types.d.ts:68-...`). Check
`ctx.hasUI` (true in TUI/RPC, false in print/JSON) and `ctx.mode`:

```ts
select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
notify(message: string, type?: "info" | "warning" | "error"): void;
editor(title: string, prefill?: string): Promise<string | undefined>;
```

`ExtensionCommandContext extends ExtensionContext` (`types.d.ts:254`)
adds `waitForIdle`, `newSession`, `fork`, `navigateTree`,
`switchSession`, `reload`, `getSystemPromptOptions`. You do not need these for v1.

Package manifest (`pi-manifest.d.ts`, `packages.md`):

```ts
interface PiManifest { extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[]; }
```

Convention dirs `extensions/`, `skills/`, `prompts/`, `themes/` when no
manifest. Runtime deps in `dependencies`; pi core imports in
`peerDependencies: "*"`. Settings (`settings-manager.d.ts:64-96`):
`packages`, `extensions`, `skills`, `prompts`, `themes`,
`enableSkillCommands`. Project skills: `.pi/skills/`,
`.agents/skills/` (trusted projects only). `CONFIG_DIR_NAME` defaults
`".pi"` (`config.js:403`), so never hardcode it.

Context files (`usage.md`): global `~/.pi/agent/AGENTS.md`, ancestors,
cwd; per directory `AGENTS.override.md` beats `AGENTS.md`/`CLAUDE.md`.
Pass `--no-context-files` to disable.

## Rejected assumptions (not relied upon)

- Duplicate-command suffix form: docs show a numeric example (`/review:1`, `/review:2` in load order, `extensions.md:1529`) but types expose only
  `ResolvedCommand.invocationName` with no guaranteed format. Read back
  `pi.getCommands()` / `getRegisteredCommands()` at runtime and surface
  the actual invocation name. Never construct a suffixed name.
- No docs name an LLM-invocation API. Phase 5 stays unstarted. The deterministic draft is the only path until later docs verify a mechanism.
- No full-screen custom UI (`ctx.ui.custom`) for v1; `select`/`confirm`/
  `input`/`editor` plus a textual fallback when `hasUI` is false.
- No `ctx.sendUserMessage`/session-replacement tricks for the core flow.
- Git-ignore is not a privacy boundary; exclusions are hardcoded too.

## Minimum supported Pi version

Minimum: **0.85.1**, the version verified here. The adapter checks at
load that `typeof pi.registerCommand === "function"` and fails closed
otherwise:

> `pi-init requires pi >= 0.85.1 with extension command support
> (pi.registerCommand). Update pi, then reinstall.`

## Adapter boundary

One module touches Pi APIs: `src/extension.ts`. It registers `/init`,
parses args, and translates `ExtensionCommandContext` + `ctx.ui` into:

```ts
interface InteractionPort {
  show(text: string): Promise<void>;
  choose(title: string, options: readonly Choice[]): Promise<Choice | undefined>;
}
```

Everything under `src/` except `extension.ts` is Pi-free (Node stdlib
only) and unit-testable outside Pi via injected filesystem/process/
clock/interaction dependencies.

## Phase 5 gate: ticket 07 (re-verified against Pi 0.85.1)

Decision: omit LLM refinement entirely. Re-checked the extension API
(`dist/core/extensions/types.d.ts`) and `docs/extensions.md`. The
only model-adjacent handles are the read-only `ctx.model` /
`ctx.modelRegistry` snapshots and session-driving `sendMessage` /
`sendUserMessage` (a session hijack, already rejected above). There is
no documented one-shot completion API for extensions; reaching the
internal model runtime (`completeSimple` in
`dist/core/model-runtime.d.ts`) would be private-API use, which the
spec forbids. No supported Pi mechanism exists for the refinement
contract. Per ticket 07, the deterministic draft remains the source
of truth. Consequences, all verified in-tree:

- `src/` has no `refine.ts`, no `fetch(`, no `sendUserMessage`, and no
  network/model imports. No payload can cross an unapproved boundary.
  `test/no-llm-path.test.ts` fails closed on any
  addition and guards this.
- Enforce redaction (`redactSecrets`) and byte limits (`DEFAULT_LIMITS`) on
  the deterministic path. No model output needs validation. You fall back to the
  deterministic draft on invalid or over-limit output, with zero write-path difference.
- You can run the extension with the skill absent or
  disabled. The skill advises and changes nothing at runtime (see README).
