"""Shared MCP client for the operator scripts in this directory.

Every script here talks to the robot the same way: one JSON-RPC message per call, over HTTP, to a
robot named by STACKCHAN_HOST. This module is that one way, so a fix (a timeout, a retry, a parsing
quirk) lands in one place instead of three.

It deliberately does **not** know the bearer token. scripts/mcp.sh fetches it from the OS keychain at
call time and hands it to curl; nothing here ever holds it, prints it, or could leak it into a log or
a transcript. A script that needs the robot needs only the host.

Import it from a sibling script (the script's own directory is on sys.path):

    import stackchan_client as robot
    robot.require_host()
    response = robot.call("get_robot_info")
    print(robot.text_of(response))

`call` returns None for every failure that is not the robot's answer - unreachable, timed out,
unparseable. A tool that ran and refused is a real answer: it comes back with `isError` set, which
`is_error` reports and `text_of` treats as no text.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MCP = os.path.join(ROOT, "scripts", "mcp.sh")

DEFAULT_TIMEOUT_S = 90
# curl gets the budget the caller asked for; the subprocess gets more, so a hung curl still ends as a
# curl error we can report rather than a Python traceback.
SUBPROCESS_GRACE_S = 15

# Anything token-shaped, for output that gets written to a file or pasted into an issue. The robot's
# token is 64 hex characters; the bearer header form is matched too, whatever the value looks like.
# The bare-hex net starts at 48 characters on purpose: long enough for this project's token, short
# enough to leave a 40-character git commit SHA intact, which is often the most useful line in a
# diagnostics bundle. Anything shorter and secret is caught by its label instead.
_SECRET_PATTERNS = (
    re.compile(r"(?i)\b(bearer)\s+\S+"),
    re.compile(r"(?i)\b([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key))\b(\s*[:=]\s*)\S+"),
    re.compile(r"\b[0-9a-fA-F]{48,}\b"),
)


def require_host() -> str:
    """The robot to talk to, or exit 2. No default: a script must be pointed at a robot on purpose."""
    host = os.environ.get("STACKCHAN_HOST")
    if not host:
        print("set STACKCHAN_HOST to the robot IP (ip or ip:port)", file=sys.stderr)
        raise SystemExit(2)
    return host


def rpc(method: str, params: dict | None = None, timeout_s: int = DEFAULT_TIMEOUT_S) -> dict | None:
    """Sends one JSON-RPC request. Returns the parsed response, or None if the robot did not answer."""
    message: dict = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        message["params"] = params
    environment = dict(os.environ, MCP_TIMEOUT=str(timeout_s))
    try:
        finished = subprocess.run(
            [MCP, json.dumps(message)],
            capture_output=True,
            text=True,
            env=environment,
            timeout=timeout_s + SUBPROCESS_GRACE_S,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if finished.returncode != 0 or not finished.stdout.strip():
        return None
    try:
        return json.loads(finished.stdout)
    except json.JSONDecodeError:
        return None


def call(tool: str, arguments: dict | None = None, timeout_s: int = DEFAULT_TIMEOUT_S) -> dict | None:
    """Calls one MCP tool. Returns the parsed response, or None if the robot did not answer."""
    return rpc("tools/call", {"name": tool, "arguments": arguments or {}}, timeout_s=timeout_s)


def result_of(response: dict | None) -> dict | None:
    """The `result` object of a response, or None for a transport failure or a protocol-level error."""
    if not response:
        return None
    result = response.get("result")
    return result if isinstance(result, dict) else None


def is_error(response: dict | None) -> bool:
    """True when the tool ran and refused. A robot that never answered is not an error result."""
    result = result_of(response)
    return bool(result and result.get("isError"))


def blocks(response: dict | None, kind: str | None = None) -> list[dict]:
    """The content blocks of a tool result, optionally only those of one type."""
    result = result_of(response)
    if not result:
        return []
    content = result.get("content")
    if not isinstance(content, list):
        return []
    return [block for block in content if kind is None or block.get("type") == kind]


def text_of(response: dict | None) -> str | None:
    """The text blocks of a successful tool result, joined. None if the call failed or errored."""
    if is_error(response):
        return None
    found = [block.get("text", "") for block in blocks(response, "text")]
    return "\n".join(found) if found else None


def any_text(response: dict | None) -> str:
    """Every text block, error results included. For reporting what a refusal actually said."""
    return "\n".join(block.get("text", "") for block in blocks(response, "text"))


def redact(text: str) -> str:
    """Replaces token-shaped material. Used before anything is written to a file a human might share."""
    text = _SECRET_PATTERNS[0].sub(r"\1 <redacted>", text)
    text = _SECRET_PATTERNS[1].sub(r"\1\2<redacted>", text)
    return _SECRET_PATTERNS[2].sub("<redacted>", text)


def emit(message: str, stream=None) -> None:
    """One line per event or state change, timestamped and flushed, so a monitor sees it immediately."""
    stamp = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    print(f"{stamp} {message}", file=stream or sys.stdout, flush=True)
