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
    """The buffer's highest sequence number, which every get_recent_events answer reports.

    Case-insensitive on purpose: the MOD writes "Highest seq overall" when it has nothing to return and
    "(highest seq overall: N)" when it does. A reader that sees only the second form reads 0 for an empty
    answer, which is indistinguishable from a robot that has just restarted - and that is precisely the
    comparison the restart detection below makes.
    """
    match = re.search(r"highest seq(?: overall)?: (\d+)", text, re.IGNORECASE)
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


def _first_line(response: dict | None) -> str:
    """The first line of whatever a refusal said, for announcing it. Never raises.

    `any_text` returns "" when an error result carries no text block at all, and "".splitlines() is [],
    so indexing it blindly turns a refusing robot into a dead watcher.
    """
    return (robot.any_text(response).strip().splitlines() or ["no reason given"])[0]


def follow(
    wait_ms: int = DEFAULT_WAIT_MS,
    retry_seconds: int = RETRY_SECONDS,
    on_state: Callable[[str], None] | None = None,
    deadline: float | None = None,
) -> Iterator[dict]:
    """Yields events as they happen, until `deadline` (a time.time() value) if one is given.

    A consumer watching only for events cannot tell a quiet room from a dead script, so state changes are
    announced - once per transition, not once per attempt.

    The deadline is checked here rather than by the consumer because this generator yields only events: in
    a quiet room it loops internally and never hands control back, so a caller counting seconds between
    yields is waiting for a physical event that may never come.
    """
    announce = on_state or (lambda message: None)
    call_timeout_s = wait_ms // 1000 + 15

    # The cursor is established before anything is watched, and retried until it can be: an unusable
    # baseline used to mean starting from 0, which replays the whole ring buffer as if it were new - in
    # `react.py --act` that is rules firing on events from minutes ago.
    reachable = True
    sequence = None
    while sequence is None:
        if deadline is not None and time.time() >= deadline:
            announce("deadline reached")
            return
        baseline = robot.text_of(robot.call("get_recent_events", {"limit": 1}, timeout_s=call_timeout_s))
        if baseline is not None:
            sequence = highest_seq(baseline)
            reachable = True
            announce(f"watching from seq={sequence}")
            break
        if reachable:
            announce("unreachable: robot not answering")
            reachable = False
        time.sleep(retry_seconds)
    degraded = False

    while True:
        if deadline is not None and time.time() >= deadline:
            announce("deadline reached")
            return
        response = robot.call("wait_for_event", {"timeout_ms": wait_ms}, timeout_s=call_timeout_s)
        if response is None:
            if reachable:
                announce("unreachable: robot not answering")
                reachable = False
            time.sleep(retry_seconds)
            continue
        if not reachable:
            announce("reachable again")
            reachable = True

        # A wait that did not block is an answer, not silence - a tool-level refusal (the robot caps
        # concurrent waiters) or a protocol error (no such tool on an older MOD). Reading it through
        # `text_of`, which returns None for all three, made every one of them look like a robot that had
        # stopped responding. Polling still works in both cases, so say so once and keep pulling.
        #
        # The sleep is what makes that safe. This loop has no pacing of its own: `wait_for_event` blocking
        # for wait_ms IS the pacing, so a wait that returns instantly turns it into a hot poll - measured
        # at over a million calls a second against a fake, and network-bound against a real robot with four
        # connection slots, forever, with nothing to stop it.
        if robot.text_of(response) is None:
            if not degraded:
                announce(f"cannot wait, polling every {retry_seconds}s instead: {_first_line(response)}")
                degraded = True
            time.sleep(retry_seconds)
        elif degraded:
            announce("waiting works again")
            degraded = False

        # The backlog is pulled on every pass, including after a timeout. `wait_for_event` resolves only
        # for events recorded after the call starts, so anything that landed while the consumer was busy -
        # running a say, a wait, or any slow action - is invisible to the next wait. Skipping the pull on a
        # timeout left those events unread until some unrelated event happened to arrive, which in a quiet
        # room is never. The pull answers instantly and costs one round trip per idle wait.
        batch = robot.text_of(
            robot.call("get_recent_events", {"since_seq": sequence, "limit": BACKLOG_LIMIT}, timeout_s=call_timeout_s)
        )
        if batch is None:
            continue

        # The robot numbers events from 1 on every boot, so a restart leaves this cursor in the future and
        # `seq > since_seq` matches nothing - forever. Without this the loop keeps running, keeps reporting
        # the robot reachable, and delivers nothing again, which is exactly what a quiet room looks like.
        # The reported highest seq is the tell and it is in every answer, which is why highest_seq has to
        # read every form of it.
        highest = highest_seq(batch)
        if highest < sequence:
            announce(f"robot restarted: event seq reset ({sequence} -> {highest})")
            sequence = 0
            batch = robot.text_of(
                robot.call("get_recent_events", {"since_seq": sequence, "limit": BACKLOG_LIMIT}, timeout_s=call_timeout_s)
            )
            if batch is None:
                continue
            highest = highest_seq(batch)

        for event in parse(batch):
            sequence = max(sequence, event["seq"])
            yield event
        sequence = max(sequence, highest)
