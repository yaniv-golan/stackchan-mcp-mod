#!/usr/bin/env python3
"""A local web panel for comparing robot expressions and messages side by side.

    STACKCHAN_HOST=<ip> scripts/panel.py [--port 8099]

Why this exists: reviewing a facial expression by watching a timed sequence is miserable - it moves on
whether or not you were looking, and comparing two expressions means re-running the whole thing. This is
a page you click: pick an emotion, see it, pick another, compare. It is a **human interface**, not an
agent interface (see AGENTS.md, "Where a capability belongs: MCP tool or script?") - an assistant already
has the MCP tools this proxies and would never use this page itself.

**Binds to 127.0.0.1 only, never 0.0.0.0.** This page drives a robot that lives on a LAN with other
people's devices on it; listening on every interface would let anything else on that network drive the
robot through this page, with no token check of its own.

**The browser never sees the robot's bearer token.** The page POSTs to this local server, which calls the
robot through scripts/stackchan_client.py, which shells out to scripts/mcp.sh, which reads the token from
the OS keychain at call time. That is the whole reason this is a proxy rather than a static HTML file
opened directly: a static page would have to carry the token itself, or ask the operator to paste it into
a browser field, either of which puts it somewhere it does not currently live.

**A fixed action allowlist, same discipline as scripts/react.py.** The server maps a small, named set of
actions to specific tool calls with validated arguments and refuses everything else; it does not accept a
tool name and arguments from the page. Without that, a convenience page turns into a general robot-control
surface reachable by anything that can reach 127.0.0.1:8099 in that browser - including a malicious tab,
since browsers do not sandbox localhost the way they sandbox the wider network. The vocabulary here is
deliberately smaller than react.py's: no camera, no microphone, no restart_robot, and no motion - this is
for comparing faces and messages, not a robot-control console.

The bearer token is never handled here: scripts/mcp.sh fetches it from the OS keychain at call time.
"""

from __future__ import annotations

import argparse
import http.server
import json
import re
import sys
import threading
import webbrowser
from dataclasses import dataclass
from typing import Callable

import stackchan_client as robot

# Never 0.0.0.0 - see module docstring.
BIND_HOST = "127.0.0.1"
DEFAULT_PORT = 8099

EMOTIONS = ("NEUTRAL", "ANGRY", "SAD", "HAPPY", "SLEEPY", "DOUBTFUL", "COLD", "HOT")
# set_emotion quantizes intensity to three levels internally; offering exactly these three values means
# every button press lands on a distinct, reproducible expression instead of a slider value that looks
# different from the last one for no visible reason.
INTENSITIES = (0.0, 0.5, 1.0)
INTENSITY_LABELS = {0.0: "subtle", 0.5: "normal", 1.0: "strong"}
BALLOON_SIZES = ("small", "medium", "large")
TEXT_LIMIT = 200
MAX_BODY_BYTES = 4096
CALL_TIMEOUT_S = 30
STATE_POLL_MS = 4000

STATE_LINE = re.compile(r"^State: (.*)$", re.MULTILINE)
UPTIME_LINE = re.compile(r"^Uptime: (\d+) s$", re.MULTILINE)


def _text(body: dict, key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string")
    return value[:TEXT_LIMIT]


def _choice(body: dict, key: str, options: tuple) -> object:
    value = body.get(key)
    if value not in options:
        raise ValueError(f"{key} must be one of {', '.join(str(o) for o in options)}")
    return value


@dataclass
class Action:
    """One entry in the allowlist: the tool it calls and how to build validated arguments for it."""

    tool: str
    build: Callable[[dict], dict]


# The whole vocabulary this page can reach. Nothing here accepts an arbitrary tool name or argument from
# the request body - every field is checked against a fixed set of options or truncated to a fixed length
# before it reaches robot.call().
ACTIONS: dict[str, Action] = {
    "set_emotion": Action(
        "set_emotion",
        lambda b: {"emotion": _choice(b, "emotion", EMOTIONS), "intensity": _choice(b, "intensity", INTENSITIES)},
    ),
    "show_message": Action(
        "show_message",
        lambda b: {"text": _text(b, "text"), "size": _choice(b, "size", BALLOON_SIZES)},
    ),
    "say_message": Action("say_message", lambda b: {"message": _text(b, "message")}),
    # Both clear the balloon; show_message is the only thing that can cover the face on this robot, so
    # hiding it is also how the face comes back. Two buttons because "clear what I put up" and "show me
    # the face again" are different operator intents even though they are the same call today.
    "clear_balloon": Action("hide_message", lambda b: {}),
    "show_face": Action("show_face", lambda b: {}),
}


def fetch_state() -> dict:
    """Calls get_robot_info and pulls out the two lines the readout cares about."""
    response = robot.call("get_robot_info", {}, timeout_s=CALL_TIMEOUT_S)
    if response is None:
        return {"ok": False, "error": "robot did not answer"}
    if robot.is_error(response):
        return {"ok": False, "error": robot.any_text(response).strip()}
    text = robot.text_of(response) or ""
    state_match = STATE_LINE.search(text)
    uptime_match = UPTIME_LINE.search(text)
    return {
        "ok": True,
        "state": state_match.group(1) if state_match else "unknown",
        "uptime_seconds": int(uptime_match.group(1)) if uptime_match else None,
    }


def render_page() -> bytes:
    emotion_rows = []
    for emotion in EMOTIONS:
        buttons = "".join(
            f'<button onclick="act(\'set_emotion\',{{emotion:\'{emotion}\',intensity:{intensity}}})">'
            f"{INTENSITY_LABELS[intensity]}</button>"
            for intensity in INTENSITIES
        )
        emotion_rows.append(f'<tr><th>{emotion}</th><td class="buttons">{buttons}</td></tr>')
    size_options = "".join(f'<option value="{size}">{size}</option>' for size in BALLOON_SIZES)

    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StackChan panel</title>
<style>
  body {{ font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem;
         color: #222; }}
  h1 {{ font-size: 1.3rem; }}
  h2 {{ font-size: 1rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: 0.25rem; }}
  table {{ width: 100%; border-collapse: collapse; }}
  th {{ text-align: left; font-weight: normal; padding: 0.25rem 0; width: 8rem; }}
  td.buttons {{ display: flex; gap: 0.4rem; }}
  button {{ padding: 0.35rem 0.7rem; border: 1px solid #999; border-radius: 4px; background: #f5f5f5;
           cursor: pointer; }}
  button:hover {{ background: #e8e8e8; }}
  button:disabled {{ opacity: 0.5; cursor: default; }}
  .row {{ display: flex; gap: 0.5rem; margin: 0.5rem 0; align-items: center; }}
  input[type=text] {{ flex: 1; padding: 0.35rem; border: 1px solid #999; border-radius: 4px; }}
  select {{ padding: 0.35rem; border: 1px solid #999; border-radius: 4px; }}
  #status {{ font-family: ui-monospace, monospace; font-size: 0.85rem; white-space: pre-wrap; min-height: 1.2em;
            margin-top: 0.5rem; color: #444; }}
  #readout {{ font-family: ui-monospace, monospace; font-size: 0.85rem; color: #444; }}
  #readout.stale {{ color: #b00; }}
</style>
</head>
<body>
<h1>StackChan panel</h1>

<h2>Emotion</h2>
<table>{"".join(emotion_rows)}</table>

<h2>Show message</h2>
<div class="row">
  <input type="text" id="show-text" placeholder="Text for the balloon" maxlength="{TEXT_LIMIT}">
  <select id="show-size">{size_options}</select>
  <button onclick="doShow()">Show</button>
</div>

<h2>Say</h2>
<div class="row">
  <input type="text" id="say-text" placeholder="Text to speak" maxlength="{TEXT_LIMIT}">
  <button onclick="doSay()">Say</button>
</div>

<h2>Balloon</h2>
<div class="row">
  <button onclick="act('clear_balloon',{{}})">Clear balloon</button>
  <button onclick="act('show_face',{{}})">Show face</button>
</div>

<div id="status"></div>

<h2>Robot state</h2>
<div id="readout">connecting...</div>

<script>
function setStatus(text) {{
  document.getElementById('status').textContent = text;
}}

async function act(action, extra) {{
  const buttons = document.querySelectorAll('button');
  buttons.forEach(b => b.disabled = true);
  setStatus('sending ' + action + '...');
  try {{
    const res = await fetch('/action', {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify(Object.assign({{action: action}}, extra)),
    }});
    const data = await res.json();
    setStatus((res.ok && data.ok ? 'ok: ' : 'error: ') + (data.message || data.error || res.status));
  }} catch (err) {{
    setStatus('request failed: ' + err);
  }} finally {{
    buttons.forEach(b => b.disabled = false);
    refreshState();
  }}
}}

function doShow() {{
  const text = document.getElementById('show-text').value;
  const size = document.getElementById('show-size').value;
  if (!text) {{ setStatus('type something first'); return; }}
  act('show_message', {{text: text, size: size}});
}}

function doSay() {{
  const message = document.getElementById('say-text').value;
  if (!message) {{ setStatus('type something first'); return; }}
  act('say_message', {{message: message}});
}}

async function refreshState() {{
  const readout = document.getElementById('readout');
  try {{
    const res = await fetch('/state');
    const data = await res.json();
    if (data.ok) {{
      const uptime = data.uptime_seconds == null ? '?' : data.uptime_seconds + 's';
      readout.textContent = data.state + '  (uptime ' + uptime + ')';
      readout.classList.remove('stale');
    }} else {{
      readout.textContent = data.error || 'no answer';
      readout.classList.add('stale');
    }}
  }} catch (err) {{
    readout.textContent = 'unreachable: ' + err;
    readout.classList.add('stale');
  }}
}}

refreshState();
setInterval(refreshState, {STATE_POLL_MS});
</script>
</body>
</html>
"""
    return html.encode("utf-8")


PAGE = render_page()


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "stackchan-panel/1"

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - matches base class signature
        sys.stderr.write(f"{self.address_string()} {format % args}\n")

    def _origin_ok(self) -> bool:
        """Refuses a cross-origin POST. A page in another tab can still reach 127.0.0.1:PORT - browsers
        do not treat localhost as protected the way they treat other origins - so a mutating request is
        only trusted when it names our own origin or names none at all (a same-origin fetch and curl both
        omit or match it; a browser page on a different origin cannot spoof it)."""
        origin = self.headers.get("Origin")
        if not origin:
            return True
        return origin == f"http://{BIND_HOST}:{self.server.server_port}"

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - required name from BaseHTTPRequestHandler
        if self.path in ("/", "/index.html"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(PAGE)))
            self.end_headers()
            self.wfile.write(PAGE)
        elif self.path == "/state":
            self._send_json(200, fetch_state())
        else:
            self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - required name from BaseHTTPRequestHandler
        if self.path != "/action":
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        if not self._origin_ok():
            self._send_json(403, {"ok": False, "error": "cross-origin request refused"})
            return
        if "application/json" not in self.headers.get("Content-Type", ""):
            self._send_json(400, {"ok": False, "error": "Content-Type must be application/json"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send_json(400, {"ok": False, "error": "body missing or too large"})
            return
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"ok": False, "error": "body is not valid JSON"})
            return
        if not isinstance(body, dict):
            self._send_json(400, {"ok": False, "error": "body must be a JSON object"})
            return

        name = body.get("action")
        action = ACTIONS.get(name)
        if action is None:
            # The allowlist decides what can run, not the request: an unrecognized action name is
            # refused here rather than passed through as a tool name.
            self._send_json(
                400,
                {"ok": False, "error": f"unknown action {name!r}; allowed: {', '.join(sorted(ACTIONS))}"},
            )
            return
        try:
            arguments = action.build(body)
        except ValueError as error:
            self._send_json(400, {"ok": False, "error": str(error)})
            return

        response = robot.call(action.tool, arguments, timeout_s=CALL_TIMEOUT_S)
        if response is None:
            self._send_json(502, {"ok": False, "error": "robot did not answer"})
        elif robot.is_error(response):
            self._send_json(502, {"ok": False, "error": robot.any_text(response).strip()})
        else:
            self._send_json(200, {"ok": True, "message": (robot.text_of(response) or "").strip()})


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Local web panel for comparing robot facial expressions and messages by clicking instead of "
            "watching a timed sequence. Needs STACKCHAN_HOST."
        ),
        epilog=(
            "Binds to 127.0.0.1 only and is never reachable from the rest of the LAN. "
            "Actions available to the page: " + ", ".join(sorted(ACTIONS)) + ". "
            "No camera, microphone or restart_robot - see the module docstring for why."
        ),
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"local port to listen on (default {DEFAULT_PORT})")
    parser.add_argument("--no-open", action="store_true", help="do not open a browser; just print the URL")
    arguments = parser.parse_args()

    host = robot.require_host()
    server = http.server.ThreadingHTTPServer((BIND_HOST, arguments.port), Handler)
    try:
        url = f"http://{BIND_HOST}:{server.server_port}/"
        print(f"panel for robot {host}: {url}", file=sys.stderr)
        print("Ctrl-C to stop.", file=sys.stderr)
        if not arguments.no_open:
            # A panel that prints a URL and waits looks broken to the person who ran it, which is
            # the whole audience for this script. Open it, after the server can answer.
            threading.Timer(0.2, lambda: webbrowser.open(url)).start()
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
