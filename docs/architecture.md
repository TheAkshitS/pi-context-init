# Architecture

## Layout

`src/extension.ts` holds all Pi-API imports. Keep `command, root, discover, facts, draft, target, merge, validate, transaction, presentation` Pi-free. No `refine.ts` (ticket 07 closed, see `docs/pi-api-notes.md` Phase 5 gate). Keep the skill at `skills/repository-analysis/SKILL.md`.

## Adapter boundary

Keep Pi-API imports in `src/extension.ts`. Translate handler context + UI calls there into a minimal internal `InteractionPort` (`show`/`choose`). Inject filesystem, process, clock, and interaction dependencies into the deterministic core so you can test outside Pi. Feed it the same facts and you get an identical draft.

## Verification gate (before any Pi-integration code)

Recheck docs + types for the target Pi version, record URLs, version/commit, exact signatures, and rejected assumptions in `docs/pi-api-notes.md`. Implement confirmed APIs and nothing else. Assume one name: `pi.registerCommand`. Never touch private fields, monkey-patch, invent types, or scrape terminal output.

## Dependencies

Build core on TypeScript + Node stdlib (`fs`, `path`, `child_process`). Add a dep when you need it. Keep the list short and pinned.

## Skill policy

Use the optional skill for advice on evidence evaluation and concise instruction writing. Install it through the documented Pi skill mechanism. Keep command dispatch, filesystem mutation, and safety-policy decisions in the extension, not the skill. You can run the extension with the skill absent or disabled.
