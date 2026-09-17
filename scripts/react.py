#!/usr/bin/env python3
"""React to what happens to the robot: match its input events against rules and run small routines.

    STACKCHAN_HOST=<ip> scripts/react.py examples/rules.json          # dry run: print what would happen
    STACKCHAN_HOST=<ip> scripts/react.py examples/rules.json --act    # actually do it
    scripts/react.py examples/rules.json --events-from captured.txt   # try rules offline, no robot

Why this exists: a robot that only answers when an assistant is mid-conversation is a puppet. Shake it at
midnight and nothing happens. The events are already there - scripts/watch-events.py streams them - and a
reaction is one tool call, so the missing piece is only the pairing, and the pairing is data.

Two things make that safe to leave running.

**Rules are data, not code.** A rule matches event fields by equality and names actions from a fixed
vocabulary; there is no expression to evaluate and no way to reach a tool this file does not list. A typo
is refused at load rather than silently never matching.

**The vocabulary leaves out capture on purpose.** No rule can take a photo or record audio. Those are the
tools whose permission a person is asked for individually, and a rule file that ran them would turn a
background process into a camera trigger nobody sees. The robot's own capture policy would still gate it -
but the useful boundary is that the vocabulary does not contain it at all. Adding motion and sound was a
judgement that a robot moving or speaking by itself is visible to anyone in the room; a camera is not.

Dry run is the default because a rule file is easy to write and hard to picture. Nothing reaches the robot
until --act, and even then every rule has a minimum interval and the whole run has an actions-per-minute
ceiling, so a sensor that gets stuck cannot become a hundred greetings.

The bearer token is never handled here: scripts/mcp.sh fetches it from the OS keychain at call time.
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
import time
from dataclasses import dataclass
from typing import Callable

import stackchan_client as robot
import stackchan_events as events

EMOTIONS = ("NEUTRAL", "ANGRY", "SAD", "HAPPY", "SLEEPY", "DOUBTFUL", "COLD", "HOT")
TEXT_LIMIT = 200
MAX_ACTIONS_PER_RULE = 8
RULE_KEYS = ("name", "comment", "when", "then", "min_interval_seconds")
DEFAULT_MIN_INTERVAL_S = 5.0
DEFAULT_ACTIONS_PER_MINUTE = 20
CALL_TIMEOUT_S = 30


def _number(spec: dict, key: str, default: float | None, low: float, high: float) -> float:
    value = spec.get(key, default)
    if value is None:
        raise ValueError(f"{key} is required")
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"{key} must be a number")
    return max(low, min(high, float(value)))


def _text(spec: dict, key: str) -> str:
    value = spec.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string")
    return value[:TEXT_LIMIT]


def _choice(spec: dict, key: str, options: tuple[str, ...]) -> str:
    value = spec.get(key)
    if value not in options:
        raise ValueError(f"{key} must be one of {', '.join(options)}")
    return value


def _rgb(spec: dict) -> dict:
    return {channel: int(_number(spec, channel, None, 0, 255)) for channel in ("r", "g", "b")}


@dataclass
class Action:
    """One entry in the vocabulary: the tool it calls and how to build its arguments."""

    tool: str | None
    build: Callable[[dict], dict]


# The whole vocabulary. Deliberately small, and deliberately without camera_take_photo, mic_listen,
# mic_get_audio, mic_record_and_play, set_torque and restart_robot - see the module docstring.
ACTIONS: dict[str, Action] = {
    "emotion": Action("set_emotion", lambda s: {"emotion": _choice(s, "emotion", EMOTIONS)}),
    "say": Action("say_message", lambda s: {"message": _text(s, "message")}),
    "show": Action(
        "show_message",
        lambda s: {"text": _text(s, "text"), "seconds": _number(s, "seconds", 5, 1, 60)},
    ),
    "hide": Action("hide_message", lambda s: {}),
    "leds": Action(
        "set_leds",
        lambda s: {**_rgb(s), "duration_ms": int(_number(s, "duration_ms", 2000, 0, 60000))},
    ),
    "blink": Action(
        "blink_leds",
        lambda s: {**_rgb(s), "duration_ms": int(_number(s, "duration_ms", 300, 50, 5000))},
    ),
    "rainbow": Action("rainbow_leds", lambda s: {}),
    "leds_off": Action("leds_off", lambda s: {}),
    "look": Action(
        "set_head_pose",
        lambda s: {
            "yaw_degrees": _number(s, "yaw_degrees", 0, -128, 128),
            "pitch_degrees": _number(s, "pitch_degrees", 0, -90, 0),
            "duration_seconds": _number(s, "duration_seconds", 0.5, 0.1, 5),
        },
    ),
    "gaze": Action(
        "look_at",
        lambda s: {axis: _number(s, axis, None, -5, 5) for axis in ("x", "y", "z")},
    ),
    "gaze_off": Action("look_away", lambda s: {}),
    "tone": Action(
        "play_tone",
        lambda s: {
            "hz": _number(s, "hz", None, 100, 8000),
            "duration_ms": int(_number(s, "duration_ms", 200, 20, 3000)),
        },
    ),
    # Not a tool: a pause between actions, so a routine can let one finish being seen.
    "wait": Action(None, lambda s: {"seconds": _number(s, "seconds", 1, 0, 5)}),
}


@dataclass
class Rule:
    name: str
    when: dict
    then: list[tuple[str, dict]]
    min_interval_s: float
    last_fired: float = 0.0

    def matches(self, event: dict) -> bool:
        """All conditions must hold. A list of values means any of them."""
        for key, wanted in self.when.items():
            actual = str(event.get(key, ""))
            options = wanted if isinstance(wanted, list) else [wanted]
            if actual not in [str(option) for option in options]:
                return False
        return True


def load_rules(path: str) -> list[Rule]:
    """Reads and validates a rules file. Every problem is fatal: a rule that cannot fire is a bug."""
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
    except OSError as error:
        raise SystemExit(f"cannot read {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise SystemExit(f"{path} is not valid JSON: {error}") from error

    entries = document.get("rules") if isinstance(document, dict) else None
    if not isinstance(entries, list) or not entries:
        raise SystemExit(f"{path} must be an object with a non-empty \"rules\" array")

    known_fields = set(events.COMMON_FIELDS)
    for fields in events.FIELDS_BY_KIND.values():
        known_fields.update(fields)

    rules = []
    for index, entry in enumerate(entries):
        where = f"rules[{index}]"
        if not isinstance(entry, dict):
            raise SystemExit(f"{where} must be an object")
        name = entry.get("name") or f"rule {index + 1}"
        unknown = [key for key in entry if key not in RULE_KEYS]
        if unknown:
            # A misspelled min_interval_seconds would otherwise quietly fall back to the default.
            raise SystemExit(f"{where} ({name}) has unknown key(s) {', '.join(unknown)}; allowed: {', '.join(RULE_KEYS)}")
        when = entry.get("when")
        if not isinstance(when, dict) or not when:
            raise SystemExit(f"{where} ({name}) needs a non-empty \"when\" object")
        kind = when.get("kind")
        if isinstance(kind, str) and kind not in events.FIELDS_BY_KIND:
            raise SystemExit(
                f"{where} ({name}) waits for kind \"{kind}\"; the kinds are "
                f"{', '.join(sorted(events.FIELDS_BY_KIND))}"
            )
        # With a fixed kind, only that kind's own fields can ever appear: a touch-panel gesture on an
        # imu rule is a rule that can never fire, which is worth refusing rather than debugging.
        allowed = set(events.COMMON_FIELDS)
        allowed.update(events.FIELDS_BY_KIND[kind] if isinstance(kind, str) else known_fields)
        for key in when:
            if key not in allowed:
                raise SystemExit(
                    f"{where} ({name}) waits on \"{key}\", which a {kind or 'robot'} event never carries. "
                    f"Fields: {', '.join(sorted(allowed))}"
                )

        steps = entry.get("then")
        if not isinstance(steps, list) or not steps:
            raise SystemExit(f"{where} ({name}) needs a non-empty \"then\" array")
        if len(steps) > MAX_ACTIONS_PER_RULE:
            raise SystemExit(f"{where} ({name}) has {len(steps)} actions; at most {MAX_ACTIONS_PER_RULE}")
        built = []
        for step in steps:
            if not isinstance(step, dict):
                raise SystemExit(f"{where} ({name}) has an action that is not an object")
            action = step.get("action")
            if action not in ACTIONS:
                raise SystemExit(
                    f"{where} ({name}) uses action \"{action}\". "
                    f"The vocabulary is: {', '.join(sorted(ACTIONS))}"
                )
            try:
                built.append((action, ACTIONS[action].build(step)))
            except ValueError as error:
                raise SystemExit(f"{where} ({name}) action \"{action}\": {error}") from error

        interval = entry.get("min_interval_seconds", DEFAULT_MIN_INTERVAL_S)
        if not isinstance(interval, (int, float)) or isinstance(interval, bool) or interval < 0:
            raise SystemExit(f"{where} ({name}) min_interval_seconds must be a non-negative number")
        rules.append(Rule(name=name, when=when, then=built, min_interval_s=float(interval)))
    return rules


class Reporter:
    """Prints one line per decision, and appends the same lines to a log file when asked."""

    def __init__(self, log_path: str | None):
        self.handle = open(log_path, "a", encoding="utf-8") if log_path else None

    def __call__(self, message: str) -> None:
        robot.emit(message)
        if self.handle:
            self.handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {message}\n")
            self.handle.flush()


def describe(event: dict) -> str:
    fields = {key: value for key, value in event.items() if key not in ("kind", "seq")}
    detail = " ".join(f"{key}={value}" for key, value in fields.items())
    return f"seq={event.get('seq', '?')} {event.get('kind', '?')} {detail}".strip()


def run_actions(rule: Rule, act: bool, report: Reporter) -> None:
    for action, arguments in rule.then:
        spec = ACTIONS[action]
        shown = json.dumps(arguments, sort_keys=True)
        if not act:
            report(f"  would run {action} {shown}")
            continue
        if spec.tool is None:  # wait
            time.sleep(arguments["seconds"])
            report(f"  waited {arguments['seconds']}s")
            continue
        response = robot.call(spec.tool, arguments, timeout_s=CALL_TIMEOUT_S)
        if response is None:
            report(f"  {action}: the robot did not answer")
        elif robot.is_error(response):
            report(f"  {action}: refused - {robot.any_text(response).strip()}")
        else:
            first = (robot.text_of(response) or "").strip().splitlines()
            report(f"  ran {action} {shown}" + (f" -> {first[0]}" if first else ""))


def offline_events(path: str) -> list[dict]:
    """Event lines captured from the robot, for trying rules without one."""
    try:
        with open(path, encoding="utf-8") as handle:
            return events.parse(handle.read())
    except OSError as error:
        raise SystemExit(f"cannot read {path}: {error}") from error


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Match robot input events against rules and run small routines. Needs STACKCHAN_HOST.",
        epilog="Actions available to a rule: " + ", ".join(sorted(ACTIONS)) + ". Capture is deliberately absent.",
    )
    parser.add_argument("rules", help="path to a rules JSON file (see examples/rules.json)")
    parser.add_argument("--act", action="store_true", help="actually call the robot (default: dry run)")
    parser.add_argument("--once", action="store_true", help="stop after the first rule fires")
    parser.add_argument("--verbose", action="store_true", help="also print events that matched nothing")
    parser.add_argument("--log", metavar="FILE", help="append every line to this file as well")
    parser.add_argument(
        "--events-from",
        metavar="FILE",
        help="replay event lines from a file instead of the robot (implies no waiting)",
    )
    parser.add_argument(
        "--max-actions-per-minute",
        type=int,
        default=DEFAULT_ACTIONS_PER_MINUTE,
        metavar="N",
        help=f"ceiling across all rules (default {DEFAULT_ACTIONS_PER_MINUTE})",
    )
    arguments = parser.parse_args()

    rules = load_rules(arguments.rules)
    report = Reporter(arguments.log)
    if arguments.events_from is None or arguments.act:
        robot.require_host()

    mode = "acting" if arguments.act else "dry run"
    report(f"{len(rules)} rule(s) loaded, {mode}" + (", replaying " + arguments.events_from if arguments.events_from else ""))

    source = offline_events(arguments.events_from) if arguments.events_from else events.follow(on_state=report)
    recent: collections.deque[float] = collections.deque()

    for event in source:
        fired = False
        for rule in rules:
            if not rule.matches(event):
                continue
            fired = True
            now = time.time()
            since = now - rule.last_fired
            if rule.last_fired and since < rule.min_interval_s:
                report(f'{describe(event)} matched "{rule.name}", rate-limited ({since:.0f}s of {rule.min_interval_s:.0f}s)')
                continue
            while recent and now - recent[0] > 60:
                recent.popleft()
            if len(recent) >= arguments.max_actions_per_minute:
                report(f'{describe(event)} matched "{rule.name}", over the ceiling of {arguments.max_actions_per_minute} actions per minute')
                continue
            rule.last_fired = now
            recent.append(now)
            report(f'{describe(event)} matched "{rule.name}"')
            run_actions(rule, arguments.act, report)
            if arguments.once:
                return 0
        if arguments.verbose and not fired:
            report(f"{describe(event)} matched nothing")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
