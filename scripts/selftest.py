#!/usr/bin/env python3
"""Exercise the robot's MCP tools and check what comes back, so a regression is found here.

    STACKCHAN_HOST=<robot-ip> scripts/selftest.py                 # the read-only checks
    STACKCHAN_HOST=<robot-ip> scripts/selftest.py --all           # everything except restart_robot
    STACKCHAN_HOST=<robot-ip> scripts/selftest.py --tier motion --json

Why this exists: a MOD cannot be verified from a laptop. The build only proves the JavaScript compiles,
and a tool call can return a cheerful success while the head never moves and the screen is dead. Every
bug this project has shipped was of that shape - the head that did not turn because torque was released
the instant `setPose` resolved, the capability report that called screen touch absent until the first
touch, a size cap applied to the wrong number. Each one survived because checking it meant a human
driving tools by hand. This runs those checks in one command instead.

So the checks assert **consequences, not status**. A pose call that returns before its own duration has
elapsed is a failure even when it reports success; a gaze that leaves the head pointing straight ahead
is a failure; a photo whose encoded size is over the body budget is a failure even though it arrived.

Tiers, because the checks are not equally quiet. `read` asks the robot questions and changes nothing;
`visual` lights LEDs and moves the face; `motion` turns the head; `audio` makes noise; `capture` uses the
camera and microphone. Only `read` runs by default. Whatever is asked for, the robot's own capture policy
still decides whether the camera and microphone answer at all - that gate lives in flash, not here.

The capture tier needs someone looking at the robot. On this hardware the display has stopped rendering -
backlit, nothing painted, every tool still answering - after a run of capture calls, and only a hardware
reset brings it back. The cause is unestablished (docs/device-notes.md has what was ruled out), and no
check here can see it, because a screen that draws nothing returns success to everything asked of it.

`restart_robot` is never run, by any flag: on this hardware a software restart leaves the screen dead
until someone power-cycles the robot by hand. It is listed as excluded so the coverage check stays honest.

Exit status: 0 if every check passed or was skipped, 1 if any failed, 2 for a usage problem or a robot
that could not be reached at all.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import time
from dataclasses import dataclass, field
from typing import Callable

import stackchan_client as robot

TIERS = ("read", "visual", "motion", "audio", "capture")

# Not run by any flag, with the reason, which the coverage check prints.
NEVER_RUN = {
    "restart_robot": "a software restart leaves this hardware's screen dead until a manual power-cycle",
}

# The device cannot send a body much over this, and taking it down is the failure mode, so the encoded
# size is what has to fit. Keep this in step with MAX_BODY_BYTES in the mod/tools-*.js that produce blobs.
MAX_ENCODED_BLOB_BYTES = 28000

CALL_TIMEOUT_S = 60

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


@dataclass
class Check:
    """One assertion about one tool. `expect` patterns must all appear in the result text."""

    name: str
    tier: str
    tool: str | None = None
    args: dict = field(default_factory=dict)
    expect: tuple[str, ...] = ()
    reject: tuple[str, ...] = ()
    expect_error: bool = False
    expect_rpc_error: int | None = None
    tolerate: tuple[str, ...] = ()
    min_seconds: float = 0.0
    settle_seconds: float = 0.0
    verify: Callable[[dict], str | None] | None = None
    note: str = ""


@dataclass
class Outcome:
    check: Check
    status: str  # pass | fail | skip
    detail: str = ""
    seconds: float = 0.0


def photo_is_usable(response: dict) -> str | None:
    """A photo has to be a real PNG that this device could actually have sent."""
    images = robot.blocks(response, "image")
    if not images:
        return "no image block in the result"
    encoded = images[0].get("data") or ""
    if images[0].get("mimeType") != "image/png":
        return f"image mimeType is {images[0].get('mimeType')!r}, expected image/png"
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError):
        return "image data is not valid base64"
    if not raw.startswith(PNG_MAGIC):
        return "image data does not start with the PNG signature"
    if len(encoded) > MAX_ENCODED_BLOB_BYTES:
        return f"encoded image is {len(encoded)} bytes, over the {MAX_ENCODED_BLOB_BYTES} byte body budget"
    return None


def recording_is_usable(response: dict) -> str | None:
    """A recording arrives as an audio resource; check it is a WAV and not an empty one."""
    resources = robot.blocks(response, "resource")
    if not resources:
        return "no resource block in the result"
    resource = resources[0].get("resource") or {}
    if resource.get("mimeType") != "audio/wav":
        return f"resource mimeType is {resource.get('mimeType')!r}, expected audio/wav"
    try:
        raw = base64.b64decode(resource.get("blob") or "", validate=True)
    except (ValueError, TypeError):
        return "resource blob is not valid base64"
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        return "resource blob is not a RIFF/WAVE file"
    if len(raw) <= 44:
        return "recording contains a WAV header and no audio"
    return None


def head_has_turned(response: dict) -> str | None:
    """While a gaze is active the reported pose is live, so it proves the head actually moved."""
    text = robot.text_of(response) or ""
    match = re.search(r"yaw=(-?[\d.]+)deg", text)
    if not match:
        return "no yaw in the pose report"
    yaw = float(match.group(1))
    if abs(yaw) < 5:
        return f"yaw is {yaw} deg; a gaze off to the side should have turned the head"
    return None


def checks() -> list[Check]:
    """Every check, in the order they run. Cleanup is separate: see RESTORE."""
    return [
        # --- read: questions only, nothing on the robot changes -------------------------------
        Check(
            name="robot reports itself",
            tier="read",
            tool="get_robot_info",
            expect=(r"^MOD: ", r"^Capture policy: ", r"^Limits: "),
        ),
        Check(
            name="input capabilities are reported from boot",
            tier="read",
            tool="get_input_capabilities",
            # The bug this pins: screen touch was reported absent until someone touched the face.
            expect=(r"head touch strip \(touch panel\): present", r"screen touch: reported by"),
            reject=(r"screen touch: not present",),
        ),
        Check(
            name="power registers are readable",
            tier="read",
            tool="get_power_registers",
            expect=(r"0x80 DCDC enable", r"0x90 LDO enable mask"),
        ),
        Check(
            name="event buffer answers",
            tier="read",
            tool="get_recent_events",
            args={"limit": 64},
            expect=(r"highest seq|No events recorded",),
        ),
        Check(
            name="head pose is readable",
            tier="read",
            tool="get_head_pose",
            expect=(r"yaw=-?[\d.]+deg", r"position=\["),
        ),
        Check(
            name="waiting for an event times out cleanly",
            tier="read",
            tool="wait_for_event",
            args={"timeout_ms": 300},
            expect=(r"No event within 300 ms|^(button|touch|touch-panel|imu)",),
        ),
        Check(
            name="an unknown tool is an -32602 error, not a crash",
            tier="read",
            tool="no_such_tool",
            expect_rpc_error=-32602,
            note="not a real tool; checks dispatch",
        ),
        Check(
            name="a missing argument is refused with a readable message",
            tier="read",
            tool="set_leds",
            args={},
            expect_error=True,
            expect=(r"r is required",),
            note="argument validation refuses before it reaches the hardware",
        ),
        Check(
            name="an out-of-range enum is refused",
            tier="read",
            tool="set_emotion",
            args={"emotion": "BANANA"},
            expect_error=True,
            expect=(r"emotion must be one of",),
        ),
        # --- visual: the face and the LEDs -----------------------------------------------------
        Check(
            name="emotion changes",
            tier="visual",
            tool="set_emotion",
            args={"emotion": "HAPPY"},
            expect=(r"HAPPY",),
        ),
        Check(name="eye opens", tier="visual", tool="set_eye_open", args={"key": "left", "value": 0.4}),
        Check(name="mouth opens", tier="visual", tool="set_mouth_open", args={"value": 0.5}),
        Check(
            name="face color is settable",
            tier="visual",
            tool="set_face_color",
            args={"key": "primary", "r": 255, "g": 255, "b": 255},
            note="set to white, which is where the restore step leaves it",
        ),
        Check(
            name="speech balloon appears",
            tier="visual",
            tool="show_message",
            args={"text": "self test", "seconds": 3},
        ),
        Check(name="speech balloon hides", tier="visual", tool="hide_message"),
        Check(
            name="LEDs take a color",
            tier="visual",
            tool="set_leds",
            args={"r": 0, "g": 0, "b": 40, "duration_ms": 600},
        ),
        Check(
            name="LEDs blink",
            tier="visual",
            tool="blink_leds",
            args={"r": 40, "g": 0, "b": 0, "duration_ms": 300},
        ),
        Check(name="LEDs run a rainbow", tier="visual", tool="rainbow_leds"),
        Check(name="LEDs turn off", tier="visual", tool="leds_off"),
        # --- motion: the head actually moves ---------------------------------------------------
        Check(
            name="a pose call waits for the motion it started",
            tier="motion",
            tool="set_head_pose",
            args={"yaw_degrees": 18, "pitch_degrees": -8, "duration_seconds": 1.0},
            # The bug this pins: setPose resolves when motion *starts*, so returning early meant
            # torque was released mid-move and the head never arrived.
            min_seconds=1.0,
            expect=(r"yaw=18.0deg", r"duration=1.00s"),
        ),
        Check(name="gaze starts", tier="motion", tool="look_at", args={"x": 0.6, "y": 0.4, "z": 0.0}),
        Check(
            name="the head is really pointing where the gaze says",
            tier="motion",
            tool="get_head_pose",
            settle_seconds=1.5,
            verify=head_has_turned,
        ),
        Check(name="gaze stops", tier="motion", tool="look_away", expect=(r"stopped",)),
        Check(name="torque is releasable", tier="motion", tool="set_torque", args={"enabled": False}),
        # --- audio: the speaker ----------------------------------------------------------------
        Check(
            name="a tone plays to the end before returning",
            tier="audio",
            tool="play_tone",
            args={"hz": 880, "duration_ms": 400},
            min_seconds=0.4,
            expect=(r"880 Hz",),
        ),
        Check(
            name="speech returns after it finishes speaking",
            tier="audio",
            tool="say_message",
            args={"message": "Self test."},
            min_seconds=0.3,
        ),
        Check(
            name="singing works, or says why not",
            tier="audio",
            tool="sing",
            args={"koe": "#C4,300ki#G4,300ra"},
            expect=(r"Sang:",),
            # Singing needs the stackchan-voice engine. On any other TTS this refusal is the
            # correct answer, not a fault, so it is a skip rather than a failure.
            tolerate=(r"does not support singing",),
        ),
        # --- capture: camera and microphone ----------------------------------------------------
        Check(
            name="a photo arrives as a PNG inside the body budget",
            tier="capture",
            tool="take_photo",
            args={"size": "160x120"},
            expect=(r"Photo: 160x120",),
            verify=photo_is_usable,
            tolerate=(r"capture is disabled|not armed",),
        ),
        Check(
            name="the microphone reports loudness",
            tier="capture",
            tool="listen",
            args={"duration_ms": 600},
            min_seconds=0.6,
            expect=(r"Recorded ~600 ms", r"Loudness: RMS "),
            tolerate=(r"capture is disabled|not armed",),
        ),
        Check(
            name="a recording arrives as a WAV",
            tier="capture",
            tool="get_recorded_audio",
            args={"duration_ms": 300, "max_bytes": 8000},
            verify=recording_is_usable,
            tolerate=(r"capture is disabled|not armed",),
        ),
        Check(
            name="a recording plays back",
            tier="capture",
            tool="record_and_play",
            args={"duration_ms": 400},
            min_seconds=0.4,
            expect=(r"Playback returned: ",),
            tolerate=(r"capture is disabled|not armed",),
        ),
    ]


# Put the robot back the way it was found. Run after any tier that changed something, and reported
# separately: a failure to clean up is worth knowing about but is not a failed check.
RESTORE = [
    ("set_head_pose", {"yaw_degrees": 0, "pitch_degrees": 0, "duration_seconds": 0.8}),
    ("set_torque", {"enabled": False}),
    ("look_away", {}),
    ("leds_off", {}),
    ("hide_message", {}),
    ("set_emotion", {"emotion": "NEUTRAL"}),
    ("set_eye_open", {"key": "left", "value": 1}),
    ("set_eye_open", {"key": "right", "value": 1}),
    ("set_mouth_open", {"value": 0}),
]

DIRTY_TIERS = {"visual", "motion"}


def served_tools() -> list[str] | None:
    """The tool names this robot currently serves, or None if it did not answer."""
    response = robot.rpc("tools/list", timeout_s=20)
    result = robot.result_of(response)
    if not result:
        return None
    return sorted(tool["name"] for tool in result.get("tools", []) if "name" in tool)


def run_check(check: Check, served: list[str]) -> Outcome:
    if check.tool and check.expect_rpc_error is None and check.tool not in served:
        return Outcome(check, "skip", "not served by this robot")
    if check.settle_seconds:
        time.sleep(check.settle_seconds)

    started = time.time()
    response = robot.call(check.tool, check.args, timeout_s=CALL_TIMEOUT_S)
    seconds = time.time() - started

    if response is None:
        return Outcome(check, "fail", "the robot did not answer", seconds)

    if check.expect_rpc_error is not None:
        error = response.get("error") or {}
        if error.get("code") == check.expect_rpc_error:
            return Outcome(check, "pass", f"code {error['code']}: {error.get('message', '')}", seconds)
        return Outcome(check, "fail", f"expected JSON-RPC error {check.expect_rpc_error}, got {json.dumps(response)[:160]}", seconds)

    text = robot.any_text(response)
    errored = robot.is_error(response)

    if errored:
        for pattern in check.tolerate:
            if re.search(pattern, text):
                return Outcome(check, "skip", text.strip().splitlines()[0] if text.strip() else "refused", seconds)
        if not check.expect_error:
            return Outcome(check, "fail", text.strip() or "error result with no message", seconds)
    elif check.expect_error:
        return Outcome(check, "fail", "expected a refusal, got success", seconds)

    for pattern in check.expect:
        if not re.search(pattern, text, re.MULTILINE):
            return Outcome(check, "fail", f"no match for /{pattern}/ in: {text.strip()[:200]!r}", seconds)
    for pattern in check.reject:
        if re.search(pattern, text, re.MULTILINE):
            return Outcome(check, "fail", f"unexpected match for /{pattern}/", seconds)

    if check.min_seconds and seconds + 0.05 < check.min_seconds:
        return Outcome(
            check,
            "fail",
            f"returned after {seconds:.2f}s but should have waited at least {check.min_seconds:.2f}s",
            seconds,
        )

    if check.verify:
        reason = check.verify(response)
        if reason:
            return Outcome(check, "fail", reason, seconds)

    return Outcome(check, "pass", text.strip().splitlines()[0] if text.strip() else "", seconds)


def coverage(served: list[str], all_checks: list[Check]) -> Outcome:
    """Fails when the robot serves a tool no check touches - the drift that makes a suite decorative."""
    check = Check(name="every tool is covered by a check", tier="read")
    covered = {c.tool for c in all_checks if c.tool}
    uncovered = [name for name in served if name not in covered and name not in NEVER_RUN]
    if uncovered:
        return Outcome(check, "fail", "no check exercises: " + ", ".join(uncovered))
    excluded = [f"{name} ({reason})" for name, reason in NEVER_RUN.items() if name in served]
    detail = f"{len(served)} tools served"
    if excluded:
        detail += "; never run: " + ", ".join(excluded)
    return Outcome(check, "pass", detail)


def restore(served: list[str]) -> list[str]:
    """Best-effort cleanup. Returns a line per step that did not work."""
    problems = []
    for tool, args in RESTORE:
        if tool not in served:
            continue
        response = robot.call(tool, args, timeout_s=20)
        if response is None or robot.is_error(response):
            problems.append(f"{tool}: {robot.any_text(response).strip() or 'no answer'}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Exercise the robot's MCP tools and check the results. Needs STACKCHAN_HOST.",
        epilog="Tiers: " + ", ".join(TIERS) + ". Only read runs by default. restart_robot is never run.",
    )
    parser.add_argument(
        "--tier",
        action="append",
        choices=TIERS,
        metavar="TIER",
        help="run this tier as well as read; repeatable (%s)" % ", ".join(TIERS),
    )
    parser.add_argument("--all", action="store_true", help="run every tier except the excluded tools")
    parser.add_argument("--json", action="store_true", help="print one JSON report instead of lines")
    parser.add_argument("--list", action="store_true", help="list the checks and their tiers, run nothing")
    arguments = parser.parse_args()

    all_checks = checks()

    if arguments.list:
        for check in all_checks:
            suffix = f" - {check.note}" if check.note else ""
            print(f"{check.tier:8} {check.tool or '-':22} {check.name}{suffix}")
        for name, reason in NEVER_RUN.items():
            print(f"{'never':8} {name:22} not run: {reason}")
        return 0

    robot.require_host()
    wanted = {"read"} | set(TIERS if arguments.all else (arguments.tier or []))

    if "capture" in wanted:
        # Nothing in this file can observe the screen, so the only safeguard is telling whoever ran it.
        print(
            "warning: the capture tier has preceded the display stopping rendering on this hardware, which "
            "only a hardware reset clears. Have someone watching the robot.",
            file=sys.stderr,
        )

    served = served_tools()
    if served is None:
        robot.emit("the robot did not answer tools/list; nothing to test", stream=sys.stderr)
        return 2

    selected = [check for check in all_checks if check.tier in wanted]
    if not arguments.json:
        print(f"{len(selected) + 1} checks in tiers: {', '.join(sorted(wanted))}")

    def record(outcome: Outcome) -> Outcome:
        if not arguments.json:
            mark = {"pass": "ok  ", "fail": "FAIL", "skip": "skip"}[outcome.status]
            print(f"{mark} [{outcome.check.tier}] {outcome.check.name}")
            if outcome.detail:
                print(f"       {outcome.detail}")
        return outcome

    outcomes = [record(coverage(served, all_checks))]
    for check in selected:
        outcomes.append(record(run_check(check, served)))

    problems = restore(served) if wanted & DIRTY_TIERS else []
    failed = [outcome for outcome in outcomes if outcome.status == "fail"]

    if arguments.json:
        print(
            json.dumps(
                {
                    "host": robot.require_host(),
                    "tiers": sorted(wanted),
                    "checks": [
                        {
                            "name": outcome.check.name,
                            "tier": outcome.check.tier,
                            "tool": outcome.check.tool,
                            "status": outcome.status,
                            "detail": robot.redact(outcome.detail),
                            "seconds": round(outcome.seconds, 2),
                        }
                        for outcome in outcomes
                    ],
                    "restore_problems": problems,
                    "passed": sum(1 for o in outcomes if o.status == "pass"),
                    "skipped": sum(1 for o in outcomes if o.status == "skip"),
                    "failed": len(failed),
                },
                indent=2,
            )
        )
    else:
        for problem in problems:
            print(f"warn restore step failed: {problem}")
        passed = sum(1 for o in outcomes if o.status == "pass")
        skipped = sum(1 for o in outcomes if o.status == "skip")
        print(f"\n{passed} passed, {skipped} skipped, {len(failed)} failed")
        for outcome in failed:
            print(f"  FAIL {outcome.check.name}: {outcome.detail}")

    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
