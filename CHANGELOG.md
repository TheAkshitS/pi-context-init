# Changelog

## [1.1.0](https://github.com/TheAkshitS/pi-context-init/compare/pi-context-init-v1.0.0...pi-context-init-v1.1.0) (2026-09-20)


### Features

* add safe init core with approval-gated writes ([5ab5775](https://github.com/TheAkshitS/pi-context-init/commit/5ab5775d4e40ab8f8b448ddf3326834c517593ad))


### Bug Fixes

* release automation: packages map and publish PATH ([82c624e](https://github.com/TheAkshitS/pi-context-init/commit/82c624ef240f6a54d3f64096f9a68806773a1dd5))

## 1.0.0

- `/init` command: bounded repository discovery, deterministic
  evidence-backed draft, exact diff preview, and atomic write gated on
  explicit approval.
- `/init update`: minimal managed-section revision preserving user-owned
  content; refuses malformed markers and symlink escapes.
- `/init audit` and `/init status`: read-only reports with deterministic
  stale-reference findings and labeled heuristics.
- Bundled `repository-analysis` skill (advisory only; core works without it).
- Requires Pi >= 0.85.1; fails closed with an actionable message otherwise.
