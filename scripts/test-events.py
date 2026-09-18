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


def test_events_arriving_during_a_blocking_action_are_still_delivered() -> None:
    print("follow: backlog after a blocking action")
    recorded: list[int] = []
    waits = {"n": 0}

    def responder(tool, args):
        if tool == "get_recent_events":
            return events_page(recorded, args.get("since_seq"), args.get("limit", 20))
        if tool == "wait_for_event":
            waits["n"] += 1
            if waits["n"] == 1:
                recorded.append(1)
                return text("Event received: seq=1 kind=imu ticks=1 motion=shake")
            return text(f"No event within {args.get('timeout_ms')} ms.")
        return None

    with fake_robot(responder):
        stream = events.follow(wait_ms=1000, retry_seconds=0)
        check("first event arrives", next(stream)["seq"], 1)
        # The consumer now blocks in say_message. Two events land. The room then goes quiet.
        recorded.extend([2, 3])
        check("stranded event 2 is delivered on the next timeout", next(stream)["seq"], 2)
        check("stranded event 3 is delivered too", next(stream)["seq"], 3)


def test_follow_recovers_when_the_robot_restarts_and_seq_resets() -> None:
    print("follow: robot restart")
    # The baseline sees 411643; 411644 arrives during the first wait, so priming does not consume it.
    recorded = [411643]
    announced: list[str] = []
    waits = {"n": 0}

    def responder(tool, args):
        if tool == "get_recent_events":
            return events_page(recorded, args.get("since_seq"), args.get("limit", 20))
        if tool == "wait_for_event":
            waits["n"] += 1
            if waits["n"] == 1:
                recorded.append(411644)
            return text("Event received: seq=? kind=imu ticks=1 motion=shake")
        return None

    with fake_robot(responder):
        stream = events.follow(wait_ms=1000, retry_seconds=0, on_state=announced.append)
        check("pre-restart event arrives", next(stream)["seq"], 411644)
        recorded[:] = [1, 2]  # the robot reboots; seq restarts at 1
        check("post-restart event arrives", next(stream)["seq"], 1)
        check("and the one after it", next(stream)["seq"], 2)
        check("the restart was announced", any("restarted" in line for line in announced), True)


def test_an_idle_wait_is_not_mistaken_for_a_restart() -> None:
    print("follow: idle waits")
    recorded = [5]
    announced: list[str] = []
    waits = {"n": 0}

    class Enough(Exception):
        pass

    def responder(tool, args):
        if tool == "get_recent_events":
            return events_page(recorded, args.get("since_seq"), args.get("limit", 20))
        if tool == "wait_for_event":
            waits["n"] += 1
            if waits["n"] > 5:
                raise Enough
            return text(f"No event within {args.get('timeout_ms')} ms.")
        return None

    with fake_robot(responder):
        stream = events.follow(wait_ms=1000, retry_seconds=0, on_state=announced.append)
        with contextlib.suppress(Enough):
            next(stream)
    check("no phantom restart across idle waits", [l for l in announced if "restarted" in l], [])


def test_a_refused_wait_is_not_reported_as_unreachable() -> None:
    print("follow: a refusal is not silence")
    recorded = [1]
    announced: list[str] = []
    waits = {"n": 0}

    class Enough(Exception):
        pass

    def responder(tool, args):
        if tool == "get_recent_events":
            return events_page(recorded, args.get("since_seq"), args.get("limit", 20))
        if tool == "wait_for_event":
            waits["n"] += 1
            if waits["n"] > 3:
                raise Enough
            # The event lands after the baseline has primed the cursor, so it can only reach the consumer
            # through the backlog pull - which is the thing this test is about.
            if waits["n"] == 1:
                recorded.append(2)
            return error("Error: 2 callers are already waiting for an event, which is this robot's limit.")
        return None

    delivered = []
    with fake_robot(responder):
        stream = events.follow(wait_ms=1000, retry_seconds=0, on_state=announced.append)
        with contextlib.suppress(Enough):
            delivered.append(next(stream)["seq"])
    check("the backlog is still delivered while waits are refused", delivered, [2])
    check("no false unreachable", [l for l in announced if "unreachable" in l], [])
    check("the refusal is announced once", len([l for l in announced if "refused" in l]), 1)


def main() -> int:
    test_highest_seq_reads_every_message_the_mod_emits()
    test_events_arriving_during_a_blocking_action_are_still_delivered()
    test_follow_recovers_when_the_robot_restarts_and_seq_resets()
    test_an_idle_wait_is_not_mistaken_for_a_restart()
    test_a_refused_wait_is_not_reported_as_unreachable()
    if FAILURES:
        print(f"\n{len(FAILURES)} failure(s)")
        return 1
    print("\nall event tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
