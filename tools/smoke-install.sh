#!/bin/sh
# Ticket 06 clean-install smoke: pack the npm artifact, install the packed
# files through Pi's documented local-path flow in an isolated HOME, and
# prove the extension and skill are discovered and the command registers.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

export HOME="$WORK/home"
mkdir -p "$HOME"

cd "$REPO"
npm pack --pack-destination "$WORK" --silent >/dev/null
mkdir -p "$WORK/pkg" && tar -xzf "$WORK"/pi-context-init-*.tgz -C "$WORK/pkg"
PKG_DIR="$WORK/pkg/package"

pi install "$PKG_DIR" >/dev/null
LIST_OUT=$(pi list)
case "$LIST_OUT" in
  *"$PKG_DIR"*) ;;
  *)
    echo "smoke: package missing from pi list"
    exit 1
    ;;
esac

ENTRY="$PKG_DIR/dist/src/extension.js"
SKILL="$PKG_DIR/skills/repository-analysis/SKILL.md"
[ -f "$ENTRY" ] || {
  echo "smoke: installed extension entry not found"
  exit 1
}
[ -f "$SKILL" ] || {
  echo "smoke: installed skill not found"
  exit 1
}

node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(process.argv[1]).href);
const factory = m.default && m.default.default ? m.default.default : (m.default || m);
if (typeof factory !== 'function') throw new Error('no factory export');
let name;
factory({ registerCommand: (n, o) => { name = n; if (typeof o.handler !== 'function') throw new Error('no handler'); } });
if (name !== 'init') throw new Error('expected /init, got ' + name);
console.log('smoke: /init registers from the installed artifact');
" "$ENTRY"

pi remove "$PKG_DIR" >/dev/null
echo "smoke: clean-install OK"
