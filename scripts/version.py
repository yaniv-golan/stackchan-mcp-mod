#!/usr/bin/env python3
"""Read or set the project version, which is declared in six files that must agree.

    scripts/version.py              # print it, or report which files disagree
    scripts/version.py set 0.2.0    # rewrite all six

One version covers the whole project: the MOD, the operator skill, the plugin and the marketplace ship
together and are only ever tested together, so a separate version per part would be three more numbers
to keep true for no gain. The cost of that choice is six declarations, which is exactly the kind of
bookkeeping that quietly rots - hence this script, and hence `scripts/check.sh` calling it, so a file
left behind is a failed check rather than a wrong number in a release.

The robot reports the version it was **flashed** with, so `get_robot_info` legitimately lags the source
after a bump and until the next `scripts/install.sh`. That is not drift.

`.github/ISSUE_TEMPLATE/bug_report.yml` also contains a version string and is deliberately not touched:
it is a placeholder showing a reporter what the field looks like, not a declaration of what this is.
"""

from __future__ import annotations

import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Each pattern must match its file exactly once. A pattern that stops matching is an error rather than a
# silently skipped file, because the failure mode being prevented here is a location left behind.
LOCATIONS = (
    ("mod/mod.js", r"const VERSION = '(?P<version>[^']+)'"),
    ("stackchan-robot/skills/stackchan-robot/SKILL.md", r"(?m)^  version: (?P<version>\S+)$"),
    ("stackchan-robot/.claude-plugin/plugin.json", r'"version": "(?P<version>[^"]+)"'),
    (".claude-plugin/marketplace.json", r'"version": "(?P<version>[^"]+)"'),
    ("package.json", r'"version": "(?P<version>[^"]+)"'),
    ("skill-packager.json", r'"version": "(?P<version>[^"]+)"'),
)

SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")


def read_all() -> tuple[dict[str, str], list[str]]:
    """Every declared version by path, plus a problem line per file that could not be read."""
    found: dict[str, str] = {}
    problems: list[str] = []
    for relative, pattern in LOCATIONS:
        path = os.path.join(ROOT, relative)
        try:
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
        except OSError as error:
            problems.append(f"{relative}: cannot read ({error})")
            continue
        matches = list(re.finditer(pattern, text))
        if len(matches) != 1:
            problems.append(f"{relative}: expected one version declaration, found {len(matches)}")
            continue
        found[relative] = matches[0].group("version")
    return found, problems


def set_all(version: str) -> list[str]:
    """Rewrites every declaration. Returns a line per file describing what changed."""
    changes = []
    for relative, pattern in LOCATIONS:
        path = os.path.join(ROOT, relative)
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        match = re.search(pattern, text)
        if not match:
            raise SystemExit(f"{relative}: no version declaration found; fix the pattern in this script")
        was = match.group("version")
        if was == version:
            changes.append(f"{relative}: already {version}")
            continue
        start, end = match.span("version")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text[:start] + version + text[end:])
        changes.append(f"{relative}: {was} -> {version}")
    return changes


def changelog_has(version: str) -> bool:
    try:
        with open(os.path.join(ROOT, "CHANGELOG.md"), encoding="utf-8") as handle:
            return f"## [{version}]" in handle.read()
    except OSError:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Read or set the one version this project declares in six files.",
        epilog="With no arguments it prints the version, or reports which files disagree.",
    )
    parser.add_argument("command", nargs="?", choices=("set",), help="set the version")
    parser.add_argument("version", nargs="?", help="the new version, e.g. 0.2.0")
    parser.add_argument("--quiet", action="store_true", help="print nothing when every file agrees")
    arguments = parser.parse_args()

    if arguments.command == "set":
        if not arguments.version or not SEMVER.match(arguments.version):
            print("give a version like 0.2.0", file=sys.stderr)
            return 2
        for line in set_all(arguments.version):
            print(line)
        if not changelog_has(arguments.version):
            print(f"note: CHANGELOG.md has no '## [{arguments.version}]' section yet", file=sys.stderr)
        return 0

    found, problems = read_all()
    versions = set(found.values())
    if problems or len(versions) != 1:
        print("version declarations do not agree:", file=sys.stderr)
        for relative, _pattern in LOCATIONS:
            if relative in found:
                print(f"  {found[relative]:12} {relative}", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    if not arguments.quiet:
        print(versions.pop())
    return 0


if __name__ == "__main__":
    sys.exit(main())
