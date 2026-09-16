#!/usr/bin/env bash
# Write an .xsa MOD archive to the robot's xs partition over USB (esptool verifies the write).
# Usage: scripts/install.sh [archive.xsa] [serial-port]
#
# Reset matters on M5StackChan CoreS3. The display panel does not reliably re-initialize after a warm
# reset: sometimes it comes up, sometimes the screen stays black while everything else works. A
# software restart (System.restart) never brings it back. Pulsing RTS (EN) works more often than
# esptool's own reset, and a second pulse often succeeds where the first did not - hence two pulses
# here. If the screen is still black afterwards, power-cycle by hand: hold the power button until the
# robot powers off, then press it again. That always works.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
XSA=${1:-$ROOT/build/bin/esp32/release/mod/mod.xsa}
PORT=${2:-${STACKCHAN_PORT:?set STACKCHAN_PORT or pass the serial port}}
XS_OFFSET=0xfa0000   # "xs" partition (type 0x40/1) in the stack-chan v1.1.0 partition table
XS_SIZE=$((0x40000))
SIZE=$(wc -c < "$XSA")
if [ "$SIZE" -gt "$XS_SIZE" ]; then
  echo "$XSA is $SIZE bytes; the xs partition holds $XS_SIZE" >&2
  exit 1
fi

uvx --from esptool esptool --chip esp32s3 --port "$PORT" --baud "${STACKCHAN_BAUD:-921600}" \
  --connect-attempts 5 --after no-reset write-flash "$XS_OFFSET" "$XSA"

# If esptool cannot enter download mode ("No serial data received"), press the bottom reset button
# while it retries.
echo "[install] resetting with EN pulses (display init after a warm reset is unreliable)"
uv run --with pyserial python - "$PORT" <<'PY'
import sys, time, serial
port = sys.argv[1]
s = serial.Serial()
s.port = port
s.baudrate = 115200
s.timeout = 0.5
s.dtr = False          # CoreS3 boots from a DTR/RTS sequence over native USB-JTAG; keep DTR unasserted
s.rts = False
s.open()
for _ in range(2):
    s.dtr = False
    s.rts = True       # assert EN
    time.sleep(0.3)
    s.rts = False
    time.sleep(2.0)
s.close()
print("[install] reset pulses sent; if the screen is black, power-cycle by hand")
PY
