#!/usr/bin/env python3
"""Stream the robot's input events, one line per event, for as long as this runs.

    STACKCHAN_HOST=<robot-ip> scripts/watch-events.py

Why this exists: the robot cannot push. There is no SSE on this firmware, and MCP's own notification
mechanism would need a stream the HTTP layer cannot produce. Watching therefore means asking
repeatedly - and doing that from inside a conversation costs a tool call and a turn for every empty
answer. Here the waiting happens in this process, and only real events reach stdout, so an agent can
put this under a monitor (or a human under `less`) and pay nothing while the room is quiet.

Latency is a round trip, not a poll interval: each wait blocks up to 45 s and returns the moment
something is recorded. After every event the backlog is pulled by sequence number, so a burst that
arrives during one wait is reported in full, and nothing is lost between waits.

Output is line-oriented and greppable:

    2026-09-17T07:30:01 watching from seq=41
    2026-09-17T07:30:12 touch-panel gesture=forwardSwipe position=-50 intensity=3 seq=42
    2026-09-17T07:31:44 unreachable: robot not answering

The failure lines matter. Anything watching only for event lines cannot tell a quiet room from a dead
script, so state changes are printed too - once per transition, not once per attempt.

The bearer token is never handled here: scripts/mcp.sh fetches it from the OS keychain at call time.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MCP = os.path.join(ROOT, "scripts", "mcp.sh")
WAIT_MS = int(os.environ.get("STACKCHAN_WAIT_MS", "45000"))
RETRY_SECONDS = 5


def emit(message: str) -> None:
    """One event or state change per line, flushed, so a monitor sees it immediately."""
    print(f"{datetime.datetime.now().strftime('%Y-%m-%dT%H:%M:%S')} {message}", flush=True)


def call(tool: str, arguments: dict) -> dict | None:
    """Calls one MCP tool through scripts/mcp.sh. Returns None when the robot cannot be reached."""
    request = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": arguments}}
    )
    environment = dict(os.environ, MCP_TIMEOUT=str(WAIT_MS // 1000 + 15))
    try:
        finished = subprocess.run(
            [MCP, request], capture_output=True, text=True, env=environment, timeout=WAIT_MS / 1000 + 30
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if finished.returncode != 0 or not finished.stdout.strip():
        return None
    try:
        return json.loads(finished.stdout)
    except json.JSONDecodeError:
        return None


def text_of(response: dict | None) -> str | None:
    """The first text block of a tool result, or None if the call failed or errored."""
    if not response:
        return None
    result = response.get("result")
    if not isinstance(result, dict) or result.get("isError"):
        return None
    for block in result.get("content", []):
        if block.get("type") == "text":
            return block.get("text", "")
    return None


def highest_seq(text: str) -> int:
    """The buffer's highest sequence number, which both tools report."""
    match = re.search(r"highest seq(?: overall)?: (\d+)", text)
    return int(match.group(1)) if match else 0


def report(text: str) -> int:
    """Prints every event line in a get_recent_events result; returns the new high-water mark."""
    seen = 0
    for line in text.splitlines():
        if not line.startswith("seq="):
            continue
        fields = dict(part.split("=", 1) for part in line.split() if "=" in part)
        seen = max(seen, int(fields.get("seq", 0)))
        kind = fields.pop("kind", "?")
        number = fields.pop("seq", "?")
        fields.pop("ticks", None)  # a device clock that resets on reboot; the wall clock is more useful
        detail = " ".join(f"{key}={value}" for key, value in fields.items())
        emit(f"{kind} {detail} seq={number}".replace("  ", " "))
    return max(seen, highest_seq(text))


def main() -> int:
    if not os.environ.get("STACKCHAN_HOST"):
        print("set STACKCHAN_HOST to the robot IP (ip or ip:port)", file=sys.stderr)
        return 2

    baseline = text_of(call("get_recent_events", {"limit": 1}))
    if baseline is None:
        emit("unreachable: robot not answering")
        reachable = False
        sequence = 0
    else:
        reachable = True
        sequence = highest_seq(baseline)
        emit(f"watching from seq={sequence}")

    while True:
        waited = text_of(call("wait_for_event", {"timeout_ms": WAIT_MS}))
        if waited is None:
            if reachable:
                emit("unreachable: robot not answering")
                reachable = False
            time.sleep(RETRY_SECONDS)
            continue
        if not reachable:
            emit("reachable again")
            reachable = True
            # The buffer kept going while we were away; report what was missed.
            missed = text_of(call("get_recent_events", {"since_seq": sequence, "limit": 64}))
            if missed:
                sequence = max(sequence, report(missed))
            continue
        if "No event within" in waited:
            continue  # a timeout is the normal quiet case

        batch = text_of(call("get_recent_events", {"since_seq": sequence, "limit": 64}))
        if batch:
            sequence = max(sequence, report(batch))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
