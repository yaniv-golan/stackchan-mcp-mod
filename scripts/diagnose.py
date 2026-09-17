#!/usr/bin/env python3
"""Collect everything needed to debug this robot into one directory.

    STACKCHAN_HOST=<robot-ip> scripts/diagnose.py [--out DIR]

Why this exists: debugging a report ("head doesn't move", "server seems down") otherwise means
re-deriving the same twenty curl calls and MCP calls one at a time, in whatever order the person
debugging happens to think of them. This runs them all, once, read-only, and writes each answer to
its own file plus an index (`SUMMARY.md`) - so a bundle can be attached to an issue or handed to
another agent instead of transcribed from a terminal.

It is deliberately narrow: everything here is a GET, a read-only tool, or a probe that only inspects
status codes and headers. Nothing here can move the robot, open the camera or microphone, change the
capture policy, or write a preference - see AGENTS.md's "MCP tool or script?" section for why that
line matters. A robot that never answers is itself a finding: each step records `unreachable` in its
own file and the run continues, so a dead server produces a *complete* bundle that says so, rather
than a crash that produces nothing.

The token is handled the same way everywhere else in this directory: `stackchan_client` shells out to
`scripts/mcp.sh`, which fetches it from the Keychain at call time. This script never sees it. The four
HTTP-conformance probes that need custom headers use curl directly and deliberately send no
Authorization header - they are about status codes and header shapes, not about a successful call -
so their bearer-token-shaped output, like everything else written here, is passed through
`stackchan_client.redact()` before it touches disk. That is also why this bundle is safe to paste into
a public issue.
"""

from __future__ import annotations

import argparse
import datetime
import glob
import hashlib
import json
import os
import platform
import re
import subprocess
import sys

import stackchan_client as robot
from stackchan_client import any_text, is_error, redact, rpc, text_of

# A LAN robot answers a read-only call in well under a second when it is up. These bound how long a
# single probe can take when it is not, so an unreachable host produces a complete bundle in a few
# minutes rather than the ~90 s per call scripts/mcp.sh allows for a slow tool.
CURL_TIMEOUT_S = 10
TOOL_TIMEOUT_S = 20

PING_BODY = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"})


def normalize_host(host: str) -> str:
    """Same default-port rule as scripts/mcp.sh, so probes hit the same endpoint other scripts do."""
    return host if ":" in host else f"{host}:8080"


def curl_request(
    method: str, path: str, host: str, headers: dict[str, str] | None = None, data: str | None = None
) -> tuple[int | None, str, str, str | None]:
    """Runs one curl request. Returns (status, header_text, body_text, error); status is None if the
    robot did not answer at all (refused, timed out, unreachable)."""
    url = f"http://{host}{path}"
    command = ["curl", "-sS", "-i", "--max-time", str(CURL_TIMEOUT_S), "-X", method, url]
    for name, value in (headers or {}).items():
        command += ["-H", f"{name}: {value}"]
    if data is not None:
        command += ["-d", data]
    try:
        finished = subprocess.run(command, capture_output=True, text=True, timeout=CURL_TIMEOUT_S + 10)
    except (subprocess.TimeoutExpired, OSError) as error:
        return None, "", "", str(error)
    if finished.returncode != 0:
        return None, "", "", finished.stderr.strip() or f"curl exited {finished.returncode}"
    return _parse_curl_i(finished.stdout)


def _parse_curl_i(output: str) -> tuple[int | None, str, str, str | None]:
    """Splits `curl -i` output into (status, headers, body, None). Skips any interim 100-Continue
    block by starting from the last status line, which is always the final response."""
    index = output.rfind("HTTP/")
    chunk = output[index:] if index != -1 else output
    header_part, separator, body = chunk.partition("\r\n\r\n")
    if not separator:
        header_part, separator, body = chunk.partition("\n\n")
    status_line = header_part.splitlines()[0] if header_part else ""
    match = re.match(r"HTTP/\S+\s+(\d+)", status_line)
    status = int(match.group(1)) if match else None
    return status, header_part, body, None


def probe_line(name: str, expected: str, ok: bool, actual: str) -> str:
    word = "PASS" if ok else "FAIL"
    return f"{word}  {name}: expected {expected}, got {actual}"


def run_conformance(host: str) -> tuple[str, int, int]:
    """Runs the five HTTP-conformance probes. Returns (report_text, passed, total)."""
    lines = []
    passed = 0
    total = 5

    # 1. GET /mcp -> 405. This server only speaks single-POST Streamable HTTP; a GET on /mcp getting
    # a plain 405 (rather than an SSE stream) is spec-permitted for that shape.
    status, _headers, _body, err = curl_request("GET", "/mcp", host)
    ok = status == 405
    passed += ok
    actual = str(status) if status is not None else f"unreachable ({err})"
    lines.append(probe_line("GET /mcp", "405", ok, actual))

    # 2. POST /mcp, no Authorization -> 401 with a WWW-Authenticate header. Deliberately unauthenticated:
    # this is the connection-level check that runs before the request body or token matter.
    status, headers, _body, err = curl_request(
        "POST",
        "/mcp",
        host,
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
        data=PING_BODY,
    )
    has_www_auth = bool(re.search(r"(?im)^www-authenticate:", headers))
    ok = status == 401 and has_www_auth
    passed += ok
    if status is not None:
        actual = f"{status}, WWW-Authenticate {'present' if has_www_auth else 'MISSING'}"
    else:
        actual = f"unreachable ({err})"
    lines.append(probe_line("POST /mcp (no Authorization)", "401 with WWW-Authenticate", ok, actual))

    # 3. POST /mcp with an unsupported MCP-Protocol-Version -> 400. This check runs before auth is
    # checked, so it needs no token either - curl with no Authorization header is the honest probe.
    status, _headers, _body, err = curl_request(
        "POST",
        "/mcp",
        host,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "1999-01-01",
        },
        data=PING_BODY,
    )
    ok = status == 400
    passed += ok
    actual = str(status) if status is not None else f"unreachable ({err})"
    lines.append(probe_line("POST /mcp with MCP-Protocol-Version: 1999-01-01", "400", ok, actual))

    # 4. POST /mcp with a *supported* MCP-Protocol-Version and still no Authorization -> 401, not 400.
    # The pair with probe 3 is the point: an unsupported version is refused before the token is looked
    # at, a supported one falls through to the auth check. A 400 here would mean the version validator
    # is rejecting a version the server claims to support.
    status, _headers, _body, err = curl_request(
        "POST",
        "/mcp",
        host,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-06-18",
        },
        data=PING_BODY,
    )
    ok = status == 401
    passed += ok
    actual = str(status) if status is not None else f"unreachable ({err})"
    lines.append(
        probe_line(
            "POST /mcp with MCP-Protocol-Version: 2025-06-18 (no Authorization)",
            "401 - a supported version reaches the auth check",
            ok,
            actual,
        )
    )

    # 5. Authenticated tools/call for a tool that does not exist -> JSON-RPC error -32602. This is a
    # real call, so it goes through stackchan_client like every other authenticated request here.
    response = rpc("tools/call", {"name": "no_such_tool", "arguments": {}}, timeout_s=TOOL_TIMEOUT_S)
    if response is None:
        ok = False
        actual = "unreachable"
    else:
        error = response.get("error")
        code = error.get("code") if isinstance(error, dict) else None
        ok = code == -32602
        actual = f"code {code}" if error is not None else f"no error (result={response.get('result')})"
    passed += ok
    lines.append(probe_line("authenticated tools/call name=no_such_tool", "JSON-RPC error -32602", ok, actual))

    return "\n".join(lines) + "\n", passed, total


def collect_tool(name: str, arguments: dict | None = None) -> tuple[str, str]:
    """Calls one read-only tool. Returns (file_content, status) where status is one of
    "ok", "error", "unreachable" for the summary."""
    response = robot.call(name, arguments, timeout_s=TOOL_TIMEOUT_S)
    if response is None:
        return "unreachable\n", "unreachable"
    if is_error(response):
        return f"tool ran and refused:\n{any_text(response)}\n", "error"
    text = text_of(response) or ""
    return text + ("\n" if not text.endswith("\n") else ""), "ok"


def collect_tools_list() -> tuple[str, str]:
    response = rpc("tools/list", timeout_s=TOOL_TIMEOUT_S)
    if response is None:
        return json.dumps({"error": "unreachable"}, indent=2) + "\n", "unreachable"
    payload = response.get("result", response)
    return json.dumps(payload, indent=2) + "\n", "ok"


def collect_health(host: str) -> tuple[str, str]:
    status, _headers, body, err = curl_request("GET", "/health", host)
    if status is None:
        return "unreachable\n", "unreachable"
    return f"HTTP {status}\n{body}\n", "ok" if status == 200 else "error"


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(command: list[str]) -> str:
    """Runs a local (non-robot) command and returns its combined output, or a note that it failed."""
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"({' '.join(command)} failed: {error})"
    output = (completed.stdout + completed.stderr).strip()
    if completed.returncode != 0:
        return f"({' '.join(command)} exited {completed.returncode}: {output})"
    return output


def collect_environment(host: str) -> str:
    lines = []
    lines.append(f"STACKCHAN_HOST: {host}")
    lines.append("")
    lines.append(f"git describe: {run(['git', '-C', robot.ROOT, 'describe', '--tags', '--always', '--dirty'])}")
    commit_info = run(["git", "-C", robot.ROOT, "log", "-1", "--format=%H%n%cI"])
    lines.append(f"git HEAD:\n{commit_info}")
    status = run(["git", "-C", robot.ROOT, "status", "--short"])
    lines.append(f"git status --short:\n{status if status else '(clean)'}")
    lines.append("")
    lines.append("sha256 of mod/*.js and mod/manifest.json:")
    mod_files = sorted(glob.glob(os.path.join(robot.ROOT, "mod", "*.js")))
    manifest = os.path.join(robot.ROOT, "mod", "manifest.json")
    if os.path.isfile(manifest):
        mod_files.append(manifest)
    for path in mod_files:
        relative = os.path.relpath(path, robot.ROOT)
        try:
            lines.append(f"  {sha256_of(path)}  {relative}")
        except OSError as error:
            lines.append(f"  (failed to hash {relative}: {error})")
    lines.append("")
    lines.append(f"python3 --version: {run([sys.executable, '--version'])}")
    curl_version = run(["curl", "--version"])
    lines.append(f"curl --version: {curl_version.splitlines()[0] if curl_version else '(unavailable)'}")
    lines.append(f"uname -a: {run(['uname', '-a'])}")
    return "\n".join(lines) + "\n"


def parse_robot_info(text: str) -> dict[str, str]:
    info: dict[str, str] = {}
    mod_match = re.search(r"^MOD:\s*(\S+)\s+v(\S+?),\s*(\d+)\s*tools\s*$", text, re.MULTILINE)
    if mod_match:
        info["name"] = mod_match.group(1)
        info["version"] = mod_match.group(2)
        info["tool_count"] = mod_match.group(3)
    uptime_match = re.search(r"^Uptime:\s*(\d+)\s*s\s*$", text, re.MULTILINE)
    if uptime_match:
        info["uptime_s"] = uptime_match.group(1)
    policy_match = re.search(r"^(Capture policy:.*)$", text, re.MULTILINE)
    if policy_match:
        info["capture_policy"] = policy_match.group(1)
    return info


def write_file(out_dir: str, filename: str, content: str) -> None:
    with open(os.path.join(out_dir, filename), "w", encoding="utf-8") as handle:
        handle.write(redact(content))


def build_out_dir(requested: str | None) -> str:
    if requested:
        return os.path.abspath(requested)
    timestamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    return os.path.join(robot.ROOT, "build", f"diagnostics-{timestamp}")


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="scripts/diagnose.py",
        description=(
            "Collect a read-only diagnostics bundle from the robot: health check, robot info, input "
            "capabilities, power registers, head pose, recent events, the tool list, an HTTP-conformance "
            "check, and local repo/environment context - each into its own file under one output "
            "directory, so a robot can be debugged from the bundle instead of a dozen ad-hoc curl calls. "
            "Never moves the robot, never touches the camera or microphone, never writes anything."
        ),
        epilog="Requires STACKCHAN_HOST (the robot's IP, or ip:port). The bearer token is fetched by "
        "scripts/mcp.sh from the Keychain and is never read, logged, or written by this script; every "
        "file is redacted before it is saved, so the bundle is safe to attach to a public issue.",
    )
    parser.add_argument(
        "--out",
        metavar="DIR",
        help="Output directory (default: build/diagnostics-<timestamp>/ under the repo root). "
        "Must not already exist and be non-empty.",
    )
    args = parser.parse_args()

    out_dir = build_out_dir(args.out)
    if os.path.exists(out_dir):
        if not os.path.isdir(out_dir):
            print(f"{out_dir} exists and is not a directory", file=sys.stderr)
            return 2
        if os.listdir(out_dir):
            print(f"{out_dir} exists and is not empty", file=sys.stderr)
            return 2

    host = robot.require_host()  # exits 2 with its own message if STACKCHAN_HOST is unset
    normalized_host = normalize_host(host)

    os.makedirs(out_dir, exist_ok=True)

    started = datetime.datetime.now()
    file_count = 0
    step_status: dict[str, str] = {}

    health_text, health_status = collect_health(normalized_host)
    write_file(out_dir, "health.txt", health_text)
    file_count += 1
    step_status["health"] = health_status

    robot_info_text, robot_info_status = collect_tool("get_robot_info")
    write_file(out_dir, "robot-info.txt", robot_info_text)
    file_count += 1
    step_status["robot-info"] = robot_info_status
    robot_info = parse_robot_info(robot_info_text) if robot_info_status == "ok" else {}

    for filename, tool, arguments in (
        ("input-capabilities.txt", "get_input_capabilities", None),
        ("power-registers.txt", "get_power_registers", None),
        ("head-pose.txt", "get_head_pose", None),
        ("recent-events.txt", "get_recent_events", {"limit": 64}),
    ):
        content, status = collect_tool(tool, arguments)
        write_file(out_dir, filename, content)
        file_count += 1
        step_status[tool] = status

    tools_list_text, tools_list_status = collect_tools_list()
    write_file(out_dir, "tools-list.json", tools_list_text)
    file_count += 1
    step_status["tools-list"] = tools_list_status

    conformance_text, conformance_passed, conformance_total = run_conformance(normalized_host)
    write_file(out_dir, "http-conformance.txt", conformance_text)
    file_count += 1

    write_file(out_dir, "environment.txt", collect_environment(host))
    file_count += 1

    failed_steps = [name for name, status in step_status.items() if status != "ok"]

    summary_lines = [
        "# StackChan diagnostics",
        "",
        f"Taken: {started.strftime('%Y-%m-%d %H:%M:%S')}",
        f"Host: {host}",
    ]
    if robot_info:
        summary_lines.append(
            f"MOD: {robot_info.get('name', '?')} v{robot_info.get('version', '?')}, "
            f"{robot_info.get('tool_count', '?')} tools, uptime {robot_info.get('uptime_s', '?')} s"
        )
        if "capture_policy" in robot_info:
            summary_lines.append(robot_info["capture_policy"])
    else:
        summary_lines.append("MOD: unreachable (robot did not answer get_robot_info)")
    summary_lines.append("")
    summary_lines.append(
        "Scope: read-only. Nothing in this bundle moved the robot, opened the camera or microphone, "
        "or wrote a preference."
    )
    summary_lines.append("")
    summary_lines.append(f"HTTP conformance: {conformance_passed}/{conformance_total} probes passed (see http-conformance.txt).")
    summary_lines.append("")
    if failed_steps:
        summary_lines.append(f"Collection steps that did not return `ok`: {', '.join(failed_steps)}.")
    else:
        summary_lines.append("All collection steps returned normally.")
    summary_lines.append("")
    summary_lines.append("## Files")
    summary_lines.append(f"- `health.txt` - unauthenticated GET /health ({health_status})")
    summary_lines.append(f"- `robot-info.txt` - get_robot_info ({step_status['robot-info']})")
    summary_lines.append(f"- `input-capabilities.txt` - get_input_capabilities ({step_status['get_input_capabilities']})")
    summary_lines.append(f"- `power-registers.txt` - get_power_registers ({step_status['get_power_registers']})")
    summary_lines.append(f"- `head-pose.txt` - get_head_pose ({step_status['get_head_pose']})")
    summary_lines.append(f"- `recent-events.txt` - get_recent_events, limit 64 ({step_status['get_recent_events']})")
    summary_lines.append(f"- `tools-list.json` - raw tools/list result ({step_status['tools-list']})")
    summary_lines.append(f"- `http-conformance.txt` - {conformance_passed}/{conformance_total} probes passed")
    summary_lines.append("- `environment.txt` - repo state, file hashes, local tool versions")
    summary_lines.append("")
    write_file(out_dir, "SUMMARY.md", "\n".join(summary_lines) + "\n")
    file_count += 1

    print(out_dir)
    print(f"wrote {out_dir}/ ({file_count} files, {conformance_passed}/{conformance_total} conformance probes passed)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
