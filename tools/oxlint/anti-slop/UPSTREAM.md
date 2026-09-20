# Anti-slop vendored plugin provenance

Source: `install-anti-slop` skill bundle
(`<skill-directory>/assets/anti-slop`, installed via
`node <skill-directory>/scripts/install.mjs` with the default destination).
Upstream repository/commit: unknown — the bundle records no source revision,
so no commit is claimed here.

Installed paths:

- `tools/oxlint/anti-slop/` — generic plugin entry point `index.ts`,
  `rules/`, `shared/`, and
  `vendor/eslint-stylistic/` (license + `UPSTREAM.md` retained verbatim).
  The bundle's optional `effect/` plugin was removed (2026-09-18): it was
  never registered in `.oxlintrc.json` and `effect` is not a dependency,
  so the directory was unreferenced dead code.
- `tools/oxlint/anti-slop/package.json` — local deviation, not upstream.

Intentional deviations from the copied bundle:

- Added `package.json` with `{"type": "module"}`. The repository root sets
  `"type": "commonjs"`, under which Node refuses the plugin's ESM `import`
  syntax (`Cannot use import statement outside a module`). Scoping
  `"type": "module"` to the vendored directory fixes loading without
  changing the repository's module type.
- Registered in `.oxlintrc.json` (JSON, not `oxlint.config.ts`) because
  JS/TS configs are experimental and require running Oxlint via Node, while
  the repo lints with the native `oxlint` binary (`pnpm exec oxlint src`).

Configuration: generic `anti-slop` plugin only, all generic rules plus
`oxc/no-accumulating-spread` at `"error"`. The bundle's opt-in Effect plugin
is not vendored: `effect` is not a direct dependency and nothing references it.
