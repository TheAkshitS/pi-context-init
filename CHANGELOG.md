# Changelog

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
