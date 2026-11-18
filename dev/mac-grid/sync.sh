#!/bin/sh
# Builds two copies of the page next to this script: stam/ (as committed) and mac/ (the same
# files with solverMode defaulting to 'mac'). The scripts here load them through
# RIVER_HTML=<copy>/index.html, with h.js and lib.js copied in from the stress-test folder
# (sediment-stress-test/repro/verify-river-physics-R3/).
REPO=$(cd "$(dirname "$0")/../.." && pwd)
D=$(cd "$(dirname "$0")" && pwd)
for m in stam mac; do rm -rf "$D/$m"; mkdir -p "$D/$m"; cp -r "$REPO/index.html" "$REPO/model.js" "$REPO/site.js" "$REPO/bridge" "$REPO/dev" "$D/$m/"; rm -rf "$D/$m/dev/mac-grid"; done
sed -i "s/^let solverMode = 'stam';/let solverMode = 'mac';/" "$D/mac/model.js"
grep -c "^let solverMode = 'mac';" "$D/mac/model.js"
