# pi-context-init

Pi extension (npm package) giving Pi a safe `/init`: inspect repo → draft concise instructions → show exact diff → write only on explicit approval.

- pnpm (`pnpm-lock.yaml`). Gates: `pnpm install`, `pnpm typecheck` (`tsc --noEmit`), `pnpm lint` (`oxlint src`), `pnpm format:check` (`oxfmt --check src`), `pnpm test` (`tsc` + `vitest run`), `pnpm coverage` (v8 thresholds per `docs/testing.md`).
- Target Pi >= 0.85.1; install flow `pi install npm:<package>`.
- Ticket 07 (LLM refinement) closed — omitted per `docs/pi-api-notes.md` Phase 5 gate; deterministic draft is the source of truth, no `refine.ts`.
- Commits must follow `docs/commits.md` exactly (strict conventional format; CI fails otherwise — run `pnpm check:commits` before pushing).

Details: [architecture](docs/architecture.md) · [safety](docs/safety.md) · [discovery & drafting](docs/discovery-draft.md) · [commits](docs/commits.md) · [verified Pi APIs](docs/pi-api-notes.md) · [testing](docs/testing.md)
