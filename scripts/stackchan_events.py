"""Follow the robot's input events as a stream of records.

The robot cannot push. There is no SSE on this firmware, and MCP's own notification mechanism would need
a stream the HTTP layer cannot produce. So watching means asking - but the asking can happen inside a
long-blocking call instead of a poll loop: `wait_for_event` returns the moment something is recorded, or
after its timeout, and after each event the backlog is pulled by sequence number so a burst that arrives
during one wait is never lost.

`follow` is that loop, as an iterator, so the two things that watch events - the line-printing watcher and
the rules runner - share one implementation of the part that is easy to get wrong.

Events come back as dicts of strings, plus an integer `seq`, exactly as the robot formats them:

    {"seq": 42, "kind": "touch-panel", "gesture": "forwardSwipe", "position": "-50", "intensity": "3"}

`ticks` is dropped: it is a device clock that resets on reboot, and every consumer here has a wall clock.
"""

from __future__ import annotations

import re
import time
from typing import Callable, Iterator

import stackchan_client as robot

DEFAULT_WAIT_MS = 45000
RETRY_SECONDS = 5
BACKLOG_LIMIT = 64

# Field names the robot can emit, by event kind. Used to reject a rule that waits for a field the robot
# never sends - a typo there would otherwise just never match, which is the hardest kind of bug to see.
FIELDS_BY_KIND = {
    "button": ("name", "pressed"),
    "touch": ("phase", "id", "x", "y"),
    "touch-panel": ("gesture", "position", "intensity", "tap.durationMs", "tap.maxMovement", "tap.position"),
    "imu": ("motion",),
}
COMMON_FIELDS = ("seq", "kind")


def highest_seq(text: str) -> int:
    """The buffer's highest sequence number, which both event tools report."""
    match = re.search(r"highest seq(?: overall)?: (\d+)", text)
    return int(match.group(1)) if match else 0


def parse(text: str) -> list[dict]:
    """Every event in a get_recent_events result, oldest first."""
    events = []
    for line in text.splitlines():
        if not line.startswith("seq="):
            continue
        fields = dict(part.split("=", 1) for part in line.split() if "=" in part)
        fields.pop("ticks", None)
        try:
            fields["seq"] = int(fields.get("seq", 0))
        except ValueError:
            continue
        events.append(fields)
    return sorted(events, key=lambda event: event["seq"])


def follow(
    wait_ms: int = DEFAULT_WAIT_MS,
    retry_seconds: int = RETRY_SECONDS,
    on_state: Callable[[str], None] | None = None,
) -> Iterator[dict]:
    """Yields events as they happen, forever. Reports reachability through on_state.

    A consumer watching only for events cannot tell a quiet room from a dead script, so state changes are
    announced - once per transition, not once per attempt.
    """
    announce = on_state or (lambda message: None)
    call_timeout_s = wait_ms // 1000 + 15

    baseline = robot.text_of(robot.call("get_recent_events", {"limit": 1}, timeout_s=call_timeout_s))
    if baseline is None:
        announce("unreachable: robot not answering")
        reachable = False
        sequence = 0
    else:
        reachable = True
        sequence = highest_seq(baseline)
        announce(f"watching from seq={sequence}")

    while True:
        waited = robot.text_of(robot.call("wait_for_event", {"timeout_ms": wait_ms}, timeout_s=call_timeout_s))
        if waited is None:
            if reachable:
                announce("unreachable: robot not answering")
                reachable = False
            time.sleep(retry_seconds)
            continue
        if not reachable:
            announce("reachable again")
            reachable = True
            # The buffer kept going while we were away; report what was missed.
        elif "No event within" in waited:
            continue  # a timeout is the normal quiet case

        batch = robot.text_of(
            robot.call("get_recent_events", {"since_seq": sequence, "limit": BACKLOG_LIMIT}, timeout_s=call_timeout_s)
        )
        if batch is None:
            continue
        for event in parse(batch):
            sequence = max(sequence, event["seq"])
            yield event
        sequence = max(sequence, highest_seq(batch))
