# Security

## Reporting a vulnerability

Report security issues privately through this repository's
[GitHub security advisories](https://github.com/yaniv-golan/stackchan-mcp-mod/security/advisories/new) rather than
in a public issue. Expect an acknowledgement within a week.

## What this software exposes

Installing this MOD turns the robot into a network service that can see, hear, speak and move, and hands that
service to an AI assistant. Treat it accordingly.

- **Plain HTTP, one bearer token.** There is no TLS, and none is possible here: Moddable's TLS stack is client-side
  only, with no server listener, so this is not a missing feature but a platform limit. The `mcp.token` preference
  is the only protection and travels in clear text on your LAN — anyone who reads it once can use it until you
  rotate it. The MOD refuses to serve if the token is shorter than 32 characters; use a long random one
  (`openssl rand -hex 32`), and never expose port 8080 beyond your own network.
- **The token also lives on your computer.** `claude mcp add --header ...` stores it in plaintext in
  `~/.claude.json`, and a token pasted on a command line stays in your shell history. Malware on your workstation
  has the robot. Give the robot a DHCP reservation, too: if its address changes, your client will happily send the
  token to whatever device takes that address.
- **The AI is the operator, and it can be talked into things.** Text an assistant reads — a web page, a file, an
  issue — can instruct it to take a photo or record audio, and the robot cannot tell that apart from your own
  request. Everything a tool returns, including images and audio, becomes part of the conversation and is sent to
  your model provider. Configure your client so capture tools always ask before running: in Claude Code, list

  ```
  mcp__stackchan__camera_*
  mcp__stackchan__mic_*
  mcp__stackchan__restart_robot
  ```

  under `permissions.ask`, and never mark them always-allow. This is the single most effective control against
  that path, and it is a configuration change rather than code. A tool-name glob after a literal
  `mcp__<server>__` prefix needs **Claude Code 2.1.166 or later**; on an older version list the four capture tools
  and `restart_robot` out individually instead.

  The capture tools are `camera_take_photo`, `mic_listen`, `mic_record_and_play` and `mic_get_audio`. Those four
  rules plus `restart_robot` are the whole list: nothing else on this robot opens the camera or the microphone.
  Versions before 0.3.0 called them `take_photo`, `listen`, `record_and_play` and `get_recorded_audio`, and
  **a stale `permissions.ask` rule under an old name is dangerous if you also hold a broad allow rule for this
  server** — the old rule matches nothing while the broad one matches the new names, so capture fires with no
  prompt, and Claude Code does not warn you because its stale-rule check exempts names containing `_`. Check your
  rules against the four names above. (Until 0.4.0 is flashed, a robot may still serve the old names as refusing
  stubs; from 0.4.0 they are gone entirely.)

- **Captures are announced on the robot.** A photo lights the head LEDs and plays a short chirp; a recording lights
  them for its duration. Both work when the screen is blank, which matters because this hardware's display often
  is. There is deliberately no way to suppress the indicators through a tool.
- **Anyone with the token can photograph and record the room**, make the robot speak, move its head, spend your TTS
  provider credit one `say_message` at a time, and — with an explicit acknowledgement flag — reboot the robot into
  a state where its display stays dead until someone power-cycles it by hand.
- **Secrets live in plaintext on the device, and MODs are trusted code.** `mcp.token`, `tts.token` and
  `wifi.password` sit in the robot's NVS partition. Anyone with USB access can read them — and can write any MOD to
  the unsigned MOD partition, where it runs with full access to every preference. Any MOD you install is trusted
  code; this one reads only `mcp.token` and `mcp.capture`. Use a restricted, budget-capped API key for TTS and
  revoke it if the robot leaves your control. A full flash backup contains all of this; do not share one.

## Limiting what the robot can do

The `mcp.capture` preference decides whether the camera and microphone tools exist at all. It is set over BLE,
which requires physical access to the robot. `get_robot_info` reports the current mode, but no tool can *change*
it, so neither an attacker holding the token nor an assistant following injected instructions can turn it off:

| Value | Effect |
|---|---|
| `open` (default) | Camera and microphone tools always work |
| `armed` | Those tools refuse unless someone swiped the robot's head touch strip (or pressed "Arm camera" in its drawer) within the last 10 minutes; an LED shows the armed state |
| `off` | Those tools are not registered at all, so a client never learns they exist |

```sh
uv run --with bleak scripts/set-prefs.py mcp.capture=armed
```

`armed` is worth it when the robot lives somewhere other people sit, or when an assistant runs against it
unattended. On a personal desk, `open` plus always-ask in your client is a reasonable trade — **for as long as the
robot is only reachable from your LAN, by the one client you configured.**

**Bridging the robot to a remote client breaks both halves of that trade.** This file says above to never expose
port 8080 beyond your own network, and bridging is a way that happens without anyone opening a port: some clients
can reach a local MCP server from elsewhere — Claude Desktop exposing it to Cowork is the case that prompted this
note. Two things change at once, independently:

- **The always-ask half does not travel.** `permissions.ask` is configuration belonging to one client. A second
  client reaching the same robot has its own rules, or none, and nothing about the robot enforces the first one's.
  That is why this file tells you to configure your client rather than trusting the MOD to ask.
- **The reachability half changes shape.** A LAN-only port is protected partly by the network. Bridged, the bearer
  token is all that is left — and it lives in plaintext in client configuration.

**If the robot may be reached by a client you did not configure, set `mcp.capture=off`.** The camera and
microphone tools are then never registered, and no token, client or injected instruction can bring them back. Do
not reach for `armed` here: arming is a ten-minute window on the whole robot, not a per-call confirmation, so once
you swipe the head strip for your own reasons, any client holding the token can capture freely until it lapses.

## Hardening the unauthenticated surface

Requests are handled by the firmware's HTTP layer, which buffers a body into memory before this MOD sees it and
before the token is checked. The MOD therefore rejects requests at the connection level, before the body matters:

- bodies declaring more than 8 KB are refused and the connection is closed
- `Transfer-Encoding` requests are refused, because a chunked body defeats the size check
- a connection that has not delivered its request within 10 seconds is closed (the clock stops once the body has
  arrived, so a slow tool such as `say_message` is not cut off)
- at most 4 connections are served concurrently
- the request body is always consumed with its rejection handled, so a client that sends headers and then
  disappears cannot leave an unhandled rejection — which on this platform aborts the runtime and reboots the robot
- `POST /mcp` with a non-JSON `Content-Type` is rejected, which blocks the cross-origin form a browser can send
  without a preflight
- a request carrying an `Origin` header is refused with 403, since no legitimate MCP client is a browser page

A refused connection is closed without an HTTP status, so a client sees a network error rather than "request too
large" or "too busy". That is deliberate: sending a status means reading the body first, which is the thing being
avoided.

Verified on the device: a 300 KB unauthenticated POST and a truncated-body request, both of which previously
rebooted the robot and blanked its display, are refused with the robot unaffected.

**Known remaining weaknesses, both in the firmware's HTTP layer and both unreachable from a MOD:**

- Connections that stall *before* their headers complete are never handed to MOD code. A few of them make the
  server unresponsive for as long as they are held. It recovers within seconds once they close and does not crash.
- A malformed request line (anything whose version token is not exactly `HTTP/1.1`) is rejected by the HTTP layer
  itself, which rejects both of its internal promises before any MOD code exists to attach a handler. That is an
  unhandled rejection, and an unhandled rejection reboots this device — so an unauthenticated peer can still force
  a reboot this way. Note the reboot is deferred until the rejected promise is garbage-collected, so it can land
  several requests later, which makes it confusing to diagnose from a serial log.

Both are reported upstream.

`GET /health` is unauthenticated by design and reports only that a robot is there.

## Hardening the rest

- Put the robot on an IoT VLAN with a firewall rule allowing only your workstation to reach TCP 8080 on it. A plain
  guest network would also cut off the machine running your MCP client, which is not what you want.
- Rotate `mcp.token` if it may have been exposed: set the new value over BLE, press the robot's reset button (a
  *software* restart leaves the display dead), and re-register the client.
- Keep `.env` out of version control — this repository ignores it — and keep it `chmod 600`.

## Upstream

Several limits here come from the firmware rather than this MOD: the unbounded request buffering described above,
the display failing to initialise after a software restart, and an oversized response taking the HTTP server down.
`docs/device-notes.md` records the measurements, and they are being reported to the
[stack-chan](https://github.com/stack-chan/stack-chan) project.
