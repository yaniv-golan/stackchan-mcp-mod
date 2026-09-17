#!/usr/bin/env bash
# Reset the robot over USB by pulsing EN, which is the first thing to try when the screen is black.
# Usage: scripts/reset.sh [pulses] [serial-port]        (port also from STACKCHAN_PORT)
#
# Why this exists as its own script: pulsing EN is the documented first-line recovery for a blank
# display, and it used to live only inside scripts/install.sh - so the only way to reset a robot was
# to reflash it. This is the same pulse without the write.
#
# Display initialization after any warm reset is probabilistic on this hardware. A pulse that works
# twice can fail on the next attempt, and a later pulse can succeed where an earlier one did not, so
# pass a higher count and look at the screen. If it stays black, power-cycle by hand: hold the power
# button until the robot powers off, then press it again. That always works. With a black screen you
# cannot tell whether the long press powered it off, so the sequence that works is long, long, short.
#
# This script cannot see the screen. It reports what it sent, not whether the display came back.
set -euo pipefail
PULSES=${1:-2}
PORT=${2:-${STACKCHAN_PORT:?set STACKCHAN_PORT or pass the serial port}}

uv run --with pyserial python - "$PORT" "$PULSES" <<'PY'
import sys
import time

import serial

port, pulses = sys.argv[1], int(sys.argv[2])
connection = serial.Serial()
connection.port = port
connection.baudrate = 115200
connection.timeout = 0.5
# The CoreS3 boots from a DTR/RTS sequence over native USB-JTAG, and opening the port with DTR
# asserted resets the chip on its own. Set both low before open() so the only reset is the one below.
connection.dtr = False
connection.rts = False
connection.open()
try:
    for attempt in range(1, pulses + 1):
        connection.dtr = False
        connection.rts = True   # assert EN
        time.sleep(0.3)
        connection.rts = False
        print(f"[reset] pulse {attempt} of {pulses} sent", flush=True)
        time.sleep(2.5)
finally:
    connection.close()
PY

echo "[reset] look at the screen. If it is black, power-cycle by hand: hold power until it powers off, then press again"
