#!/usr/bin/env python3
"""Stream the robot's input events, one line per event, for as long as this runs.

    STACKCHAN_HOST=<robot-ip> scripts/watch-events.py

Why this exists: the robot cannot push, so watching means asking repeatedly - and doing that from inside a
conversation costs a tool call and a turn for every empty answer. Here the waiting happens in this process,
and only real events reach stdout, so an agent can put this under a monitor (or a human under `less`) and
pay nothing while the room is quiet.

Latency is a round trip, not a poll interval: each wait blocks up to 45 s and returns the moment something
is recorded. The waiting itself lives in scripts/stackchan_events.py, which the rules runner shares.

Output is line-oriented and greppable:

    2026-09-17T07:30:01 watching from seq=41
    2026-09-17T07:30:12 touch-panel gesture=forwardSwipe position=-50 intensity=3 seq=42
    2026-09-17T07:31:44 unreachable: robot not answering

The failure lines matter. Anything watching only for event lines cannot tell a quiet room from a dead
script, so state changes are printed too - once per transition, not once per attempt.

The bearer token is never handled here: scripts/mcp.sh fetches it from the OS keychain at call time.
"""

from __future__ import annotations

import os
import sys
import time

import stackchan_client as robot
import stackchan_events as events
from stackchan_client import emit

WAIT_MS = int(os.environ.get("STACKCHAN_WAIT_MS", str(events.DEFAULT_WAIT_MS)))
# Seconds to watch for before stopping on its own; 0 means run until interrupted. A bounded run is
# what makes this usable as a step in a procedure rather than something you have to remember to kill.
RUN_FOR_S = float(os.environ.get("STACKCHAN_RUN_FOR", "0"))


def line(event: dict) -> str:
    """One event as a line: kind first, then its own fields, then the sequence number."""
    fields = {key: value for key, value in event.items() if key not in ("kind", "seq")}
    detail = " ".join(f"{key}={value}" for key, value in fields.items())
    return f"{event.get('kind', '?')} {detail} seq={event.get('seq', '?')}".replace("  ", " ")


def main() -> int:
    robot.require_host()
    deadline = time.time() + RUN_FOR_S if RUN_FOR_S > 0 else None
    for event in events.follow(wait_ms=WAIT_MS, on_state=emit, deadline=deadline):
        emit(line(event))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
