#!/usr/bin/env bash
# Repository checks that need neither the robot nor the Moddable SDK.
# Biome catches the bug class that matters most here: an undeclared identifier referenced inside a
# catch handler throws a ReferenceError, and an uncaught throw reboots the device.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

for file in scripts/*.sh; do
  bash -n "$file"
done
echo "[check] shell syntax ok"

python3 -m py_compile scripts/*.py
echo "[check] python syntax ok"

scripts/version.py --quiet
echo "[check] version declarations agree"

# The example rules are documentation that can be wrong. Loading them exercises the validator, and
# replaying the captured events exercises the matcher - neither needs a robot.
scripts/selftest.py --list >/dev/null
scripts/react.py examples/rules.json --events-from examples/captured-events.txt >/dev/null
echo "[check] example rules load and replay ok"

if command -v npx >/dev/null; then
  npx --yes @biomejs/biome@1.9.4 ci mod
  echo "[check] biome lint and format ok"
else
  echo "[check] npx not found; skipping biome. Install Node.js to run the linter." >&2
  if command -v node >/dev/null; then
    for file in mod/*.js; do
      node --check --input-type=module < "$file"
    done
    echo "[check] javascript syntax ok (linter skipped)"
  fi
fi
