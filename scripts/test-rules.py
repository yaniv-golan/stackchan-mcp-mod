#!/usr/bin/env python3
"""Offline tests for the rules-file validator.

Why this exists: a rules file is data a person writes by hand, and the validator's whole promise is that a
rule which cannot do what it says is refused at load rather than debugged at midnight. No robot, stdlib
only.
"""

from __future__ import annotations

import json
import pathlib
import sys
import tempfile

import react

FAILURES: list[str] = []


def check(name: str, got, want) -> None:
    if got == want:
        print(f"  ok   {name}")
        return
    FAILURES.append(f"{name}: got {got!r}, want {want!r}")
    print(f"  FAIL {name}: got {got!r}, want {want!r}")


def load(rules: list[dict]):
    """Loads a rules document, returning the parsed rules or the SystemExit message."""
    with tempfile.TemporaryDirectory() as directory:
        path = pathlib.Path(directory) / "rules.json"
        path.write_text(json.dumps({"rules": rules}), encoding="utf-8")
        try:
            return react.load_rules(str(path))
        except SystemExit as refusal:
            return str(refusal)


def rule(then: list[dict]) -> dict:
    return {"name": "t", "when": {"kind": "imu", "motion": "shake"}, "then": then}


def test_a_misspelled_action_key_is_refused() -> None:
    print("load_rules: unknown action keys")
    result = load([rule([{"action": "leds", "r": 1, "g": 2, "b": 3, "duration_mss": 9000}])])
    check("a typo on a key the builder reads is refused", isinstance(result, str), True)
    check("the refusal names the key", "duration_mss" in str(result), True)
    result = load([rule([{"action": "tone", "hz": 660, "duration_ms": 130, "waveform": "square"}])])
    check("a key no builder reads is refused", isinstance(result, str), True)


def test_a_correct_rule_still_loads() -> None:
    print("load_rules: valid rules")
    result = load([rule([{"action": "leds", "r": 1, "g": 2, "b": 3, "duration_ms": 9000}])])
    check("a correct step loads", isinstance(result, list), True)
    check("its argument survives", result[0].then[0][1]["duration_ms"], 9000)
    check("an action with no arguments loads", isinstance(load([rule([{"action": "hide"}])]), list), True)


def test_a_step_may_be_annotated() -> None:
    print("load_rules: per-step comment")
    result = load([rule([{"action": "hide", "comment": "put the balloon away"}])])
    check("a comment on a step is allowed", isinstance(result, list), True)


def test_blink_takes_a_period_not_a_duration() -> None:
    print("load_rules: blink period_ms")
    check(
        "duration_ms on blink is refused",
        isinstance(load([rule([{"action": "blink", "r": 1, "g": 2, "b": 3, "duration_ms": 400}])]), str),
        True,
    )
    result = load([rule([{"action": "blink", "r": 1, "g": 2, "b": 3, "period_ms": 400}])])
    check("period_ms is accepted", isinstance(result, list), True)
    # The TOOL argument stays duration_ms - blink_leds' own parameter name - so only the rules-file
    # spelling changes. This is the assertion that catches a rename done in the wrong place.
    check("and reaches the tool as duration_ms", result[0].then[0][1]["duration_ms"], 400)


def test_tone_volume_is_optional_and_passes_through() -> None:
    print("load_rules: tone volume")
    # Omitted, the tool falls through to the robot's own speaker volume - the builder must not invent a
    # default, because inventing one would silently change every existing rule's loudness.
    result = load([rule([{"action": "tone", "hz": 660, "duration_ms": 130}])])
    check("omitted, no volume is sent at all", "volume" in result[0].then[0][1], False)
    result = load([rule([{"action": "tone", "hz": 660, "duration_ms": 130, "volume": 0.6}])])
    check("given, it reaches the tool", result[0].then[0][1].get("volume"), 0.6)
    result = load([rule([{"action": "tone", "hz": 660, "duration_ms": 130, "volume": 9}])])
    check("and it is clamped", result[0].then[0][1].get("volume"), 1.0)


def test_the_shipped_example_still_loads() -> None:
    print("load_rules: examples/rules.json")
    root = pathlib.Path(__file__).resolve().parent.parent
    check("the example file loads", len(react.load_rules(str(root / "examples" / "rules.json"))) > 0, True)


def main() -> int:
    test_a_misspelled_action_key_is_refused()
    test_a_correct_rule_still_loads()
    test_a_step_may_be_annotated()
    test_blink_takes_a_period_not_a_duration()
    test_tone_volume_is_optional_and_passes_through()
    test_the_shipped_example_still_loads()
    if FAILURES:
        print(f"\n{len(FAILURES)} failure(s)")
        return 1
    print("\nall rules tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
