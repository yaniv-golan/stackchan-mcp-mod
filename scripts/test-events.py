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

# How many MCP calls any single test may provoke before it is declared stuck. Every fix here is of the
# shape "an event never arrives", and a test for one fails by never returning - so an unbounded fixture
# turns a regression into a hung `scripts/check.sh` rather than a red one. That happened during
# development of these very tests; the bound is what makes them report instead of hang.
CALL_BUDGET = 200


class Stuck(Exception):
    """Raised when a fixture has answered CALL_BUDGET calls without the test finishing."""


def bound(responder):
    """Wraps a fake responder so a loop that stops making progress ends the test instead of spinning."""
    budget = {"left": CALL_BUDGET}

    def limited(tool, args):
        budget["left"] -= 1
        if budget["left"] <= 0:
            raise Stuck(f"no progress after {CALL_BUDGET} calls")
        return responder(tool, args)

    return limited


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

    with fake_robot(bound(responder)):
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

    with fake_robot(bound(responder)):
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
    check("the refusal is announced once", len([l for l in announced if "cannot wait" in l]), 1)
    check("and it names the polling interval", any("polling every" in l for l in announced), True)


def test_follow_stops_at_its_deadline_in_a_silent_room() -> None:
    print("follow: deadline")
    import time as clock

    def responder(tool, args):
        if tool == "get_recent_events":
            return events_page([], args.get("since_seq"), args.get("limit", 20))
        if tool == "wait_for_event":
            # A real wait blocks for its timeout, and that is what the deadline has to interrupt. A fake
            # that answers instantly tests a loop that does not exist.
            clock.sleep(args.get("timeout_ms", 0) / 1000)
            return text(f"No event within {args.get('timeout_ms')} ms.")
        return None

    with fake_robot(bound(responder)):
        started = clock.time()
        drained = list(events.follow(wait_ms=50, retry_seconds=0, deadline=started + 0.3))
    check("the generator ends", drained, [])
    check("and it ended near its deadline", clock.time() - started < 5, True)


def run(test) -> None:
    """Runs one test, turning a stuck event loop into a reported failure."""
    try:
        test()
    except Stuck as stuck:
        FAILURES.append(f"{test.__name__}: {stuck}")
        print(f"  FAIL {test.__name__}: {stuck}")


def test_a_wait_that_does_not_block_does_not_become_a_hot_poll() -> None:
    print("follow: pacing when the wait is refused")
    import time as clock

    calls = {"n": 0}

    def responder(tool, args):
        calls["n"] += 1
        if tool == "get_recent_events":
            return events_page([1], args.get("since_seq"), args.get("limit", 20))
        if tool == "wait_for_event":
            # Instant, and unusable: what the robot's two-waiter cap gives a third watcher.
            return error("Error: 2 callers are already waiting for an event, which is this robot's limit.")
        return None

    # The wait is what paces this loop. When it returns instantly the loop has no pacing of its own, and
    # without an explicit sleep it polls as fast as the network allows - forever, against a device with
    # four connection slots. This is that regression, measured rather than argued.
    with fake_robot(responder):
        started = clock.time()
        list(events.follow(wait_ms=45000, retry_seconds=1, deadline=started + 2.0))
    check("a refused wait is polled, not spun", calls["n"] < 30, True)
    if calls["n"] >= 30:
        print(f"       made {calls['n']} calls in 2s")


def main() -> int:
    test_highest_seq_reads_every_message_the_mod_emits()
    run(test_events_arriving_during_a_blocking_action_are_still_delivered)
    run(test_follow_recovers_when_the_robot_restarts_and_seq_resets)
    run(test_an_idle_wait_is_not_mistaken_for_a_restart)
    run(test_a_refused_wait_is_not_reported_as_unreachable)
    run(test_follow_stops_at_its_deadline_in_a_silent_room)
    run(test_a_wait_that_does_not_block_does_not_become_a_hot_poll)
    if FAILURES:
        print(f"\n{len(FAILURES)} failure(s)")
        return 1
    print("\nall event tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
