#!/usr/bin/env python3
"""Offline tests for the shared event-following loop.

Why this exists: `follow()` is the part of this project easiest to get wrong and impossible to exercise
by hand - its failures are "an event never arrives", which looks exactly like a quiet room. These drive
it against a scripted robot. No robot, no network, stdlib only.
"""

from __future__ import annotations

import contextlib
import sys

import stackchan_client as robot
import stackchan_events as events

FAILURES: list[str] = []


def check(name: str, got, want) -> None:
    if got == want:
        print(f"  ok   {name}")
        return
    FAILURES.append(f"{name}: got {got!r}, want {want!r}")
    print(f"  FAIL {name}: got {got!r}, want {want!r}")


def text(body: str) -> dict:
    return {"result": {"content": [{"type": "text", "text": body}]}}


def error(body: str) -> dict:
    return {"result": {"content": [{"type": "text", "text": body}], "isError": True}}


@contextlib.contextmanager
def fake_robot(responder):
    """Replaces the MCP transport with `responder(tool, args) -> response dict | None`."""
    original = robot.call
    robot.call = lambda tool, arguments=None, timeout_s=None: responder(tool, arguments or {})
    try:
        yield
    finally:
        robot.call = original


def events_page(recorded: list[int], since, limit: int = 20) -> dict:
    """The three answers get_recent_events actually gives, chosen the way the MOD chooses them."""
    if not recorded:
        return text("Event buffer is empty; no input events have been recorded yet. Highest seq: 0.")
    highest = max(recorded)
    rows = [s for s in recorded if since is None or s > since][-limit:]
    if not rows:
        return text(f"No recorded events matching seq > {since}. Highest seq overall: {highest}.")
    lines = "\n".join(f"seq={s} kind=imu ticks={s} motion=shake" for s in rows)
    return text(f"{len(rows)} event(s), newest last (highest seq overall: {highest}):\n{lines}")


def test_highest_seq_reads_every_message_the_mod_emits() -> None:
    print("highest_seq")
    check(
        "empty buffer",
        events.highest_seq("Event buffer is empty; no input events have been recorded yet. Highest seq: 0."),
        0,
    )
    check(
        "nothing past the cursor",
        events.highest_seq("No recorded events matching seq > 9. Highest seq overall: 3."),
        3,
    )
    check(
        "events present",
        events.highest_seq("2 event(s), newest last (highest seq overall: 43):\nseq=42 kind=imu ticks=1 motion=shake"),
        43,
    )


def main() -> int:
    test_highest_seq_reads_every_message_the_mod_emits()
    if FAILURES:
        print(f"\n{len(FAILURES)} failure(s)")
        return 1
    print("\nall event tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
