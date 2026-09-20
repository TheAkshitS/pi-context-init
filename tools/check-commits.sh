#!/bin/sh
# Strict conventional-commit check per docs/commits.md.
# Usage: sh tools/check-commits.sh [<range>]
#   <range>  git revision range to check (default: origin/main..HEAD,
#            or HEAD when origin/main is unavailable).
# Merge commits are skipped. Exit non-zero listing every offender.
set -eu

if [ "$#" -gt 0 ]; then
  range="$1"
elif git rev-parse --verify --quiet origin/main >/dev/null; then
  range="origin/main..HEAD"
else
  range="HEAD"
fi

# A bare revision means that one commit only; a range walks history.
max=""
case "$range" in
  *..*) ;;
  *) max="--max-count=1" ;;
esac

# shellcheck disable=SC2086
count="$(git rev-list --count $max $range -- 2>/dev/null || true)"
if [ -z "$count" ] || [ "$count" = "0" ]; then
  echo "check-commits: no commits in '$range', OK"
  exit 0
fi

fail=0
# shellcheck disable=SC2086
for sha in $(git rev-list --reverse $max $range --); do
  subject="$(git log -1 --format=%s "$sha")"
  body="$(git log -1 --format=%b "$sha")"
  short="$(git rev-parse --short "$sha")"

  case "$subject" in
    "Merge "*) continue ;;
  esac

  bad=""
  if ! printf '%s' "$subject" | grep -Eq '^(feat|fix|docs|refactor|test|chore|ci|build)(\([a-z0-9_./-]+\))?(!)?: [a-z](.*[^.])?$'; then
    bad="header must match <type>(<scope>)(!): <subject>, lowercase subject, no trailing period"
  elif [ "${#subject}" -gt 72 ]; then
    bad="header exceeds 72 chars (${#subject})"
  elif printf '%s' "$subject" | grep -Eq '^[^:]*!:'; then
    if ! printf '%s' "$body" | grep -Fq 'BREAKING CHANGE:'; then
      bad="'!' requires a 'BREAKING CHANGE:' footer in the body"
    fi
  fi

  if [ -n "$bad" ]; then
    printf 'check-commits: %s "%s": %s\n' "$short" "$subject" "$bad"
    fail=1
  fi
done

if [ "$fail" = "0" ]; then
  echo "check-commits: $count commit(s) in '$range', OK"
fi
exit "$fail"
