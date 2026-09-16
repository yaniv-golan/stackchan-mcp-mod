#!/usr/bin/env bash
# Build mod.xsa for an M5StackChan CoreS3 running stack-chan firmware v1.1.0.
# Needs Moddable SDK 9.0.0 (MODDABLE) and a stack-chan v1.1.0 checkout (STACKCHAN) for the platform config.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
: "${MODDABLE:?set MODDABLE to a Moddable SDK 9.0.0 checkout}"
: "${STACKCHAN:?set STACKCHAN to a stack-chan v1.1.0 checkout}"
if [ "$(cat "$MODDABLE/tools/VERSION")" != "9.0.0" ]; then
  echo "Moddable SDK must be 9.0.0 to match the v1.1.0 host (found $(cat "$MODDABLE/tools/VERSION"))" >&2
  exit 1
fi
export PATH="$MODDABLE/build/bin/mac/release:$MODDABLE/build/bin/lin/release:$PATH"
mkdir -p "$ROOT/build"
cd "$STACKCHAN/firmware"
mcrun -m -p esp32:./host/platforms/m5stackchan_cores3 -t build -o "$ROOT/build" "$ROOT/mod/manifest.json"
XSA="$ROOT/build/bin/esp32/release/mod/mod.xsa"
ls -l "$XSA"
