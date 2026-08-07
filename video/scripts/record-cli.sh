#!/usr/bin/env bash
# Records the REAL output of the Promit CLI against the live API, colors
# included (script(1) provides the TTY picocolors needs). The video animates
# this recording verbatim — nothing in the terminal scene is typed by hand.
#
# Usage: bash scripts/record-cli.sh /path/to/promit-monorepo-checkout
set -euo pipefail
REPO="${1:?usage: record-cli.sh <path to promit monorepo checkout with deps installed>}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/public/captures"
mkdir -p "$OUT"
TMP="$(mktemp)"
(cd "$REPO" && COLUMNS=100 script -q "$TMP" bun cli/src/cli.ts search hero >/dev/null)
python3 - "$TMP" "$OUT/cli-search.ansi.txt" <<'EOF'
import sys
raw = open(sys.argv[1], 'rb').read()
# script(1) prepends ^D and backspaces before real output; drop them.
start = raw.find(b'\x1b[2m')
open(sys.argv[2], 'wb').write(raw[start:])
EOF
node "$(dirname "$0")/gen-cli-module.mjs"
echo "recorded -> public/captures/cli-search.ansi.txt"
