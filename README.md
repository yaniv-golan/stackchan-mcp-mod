# stackchan-mcp-mod

[![check](https://github.com/yaniv-golan/stackchan-mcp-mod/actions/workflows/check.yml/badge.svg)](https://github.com/yaniv-golan/stackchan-mcp-mod/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

An MCP server MOD for [Stack-chan](https://github.com/stack-chan/stack-chan) that exposes the robot's
capabilities as MCP tools, so an MCP client (Claude Code, Codex, …) can drive the robot over the network:
take a photo, listen to the room, move the head, light the LEDs, speak, and react to being touched.

It is a replacement for the stock "MCP Server" sample MOD, which offers only `set_emotion` and `say_message`
and — because a MOD's `onContextCreated` replaces the host default — switches off the built-in behaviors such as
head petting. This MOD runs the default behaviors first and then adds its own tools.

- Target: **M5StackChan CoreS3** running **stack-chan firmware v1.1.0** (host `9.0.0+stackchan.1`)
- Transport: Streamable HTTP on port 8080, `POST /mcp` with `Authorization: Bearer <mcp.token>`, `GET /health`
- No host firmware rebuild: the MOD is a JavaScript archive written to the `xs` flash partition

> **This turns your robot into a networked camera and microphone.** Read [SECURITY.md](SECURITY.md) before
> installing it, especially if the robot lives in a room where people talk.

## For coding agents

Start with [AGENTS.md](AGENTS.md) (also reachable as `CLAUDE.md`), then
[docs/architecture.md](docs/architecture.md). [llms.txt](llms.txt) is a short index of the same material. The two
constraints that catch people out: an uncaught exception reboots the device, and an oversized response takes the
HTTP server down (~28 KB bodies are known good, ~56 KB is fatal). `scripts/check.sh` runs the linter without needing hardware — but only the robot can tell you
whether a change actually works.

## Status

Working and used daily on one robot; every tool listed below has been exercised on real hardware. Only the
M5StackChan CoreS3 target is tested — other Stack-chan targets may work but nobody has tried. Expect the rough
edges documented under [Device limits](#device-limits-worth-knowing); most of them are firmware behaviour this MOD
works around rather than bugs in the MOD.

## Tools

| Tool | What it does |
|---|---|
| `set_emotion` | Sets the facial expression (`NEUTRAL, ANGRY, SAD, HAPPY, SLEEPY, DOUBTFUL, COLD, HOT`) |
| `say_message` | Speaks text with the configured TTS engine; returns after playback ends |
| `set_head_pose` | Moves the head to an absolute yaw/pitch in degrees, optionally holding the pose |
| `look_at` / `look_away` | Starts or stops gaze tracking toward a 3D point in metres |
| `get_head_pose` | Reads the last known head pose (stale unless a motion or gaze is active) |
| `set_torque` | Engages or releases the servos |
| `set_leds` / `blink_leds` / `rainbow_leds` / `leds_off` | Drives the 12-LED head ring |
| `set_face_color` / `set_mouth_open` / `set_eye_open` | Face theme colour and mouth/eyelid position |
| `get_recent_events` / `wait_for_event` | Reads buffered input events, or waits for the next one |
| `get_input_capabilities` | Reports which input devices exist and which are being recorded |
| `camera_take_photo` | Captures a photo as a PNG, grayscale or 256-colour |
| `mic_listen` | Records and reports loudness (overall, peak, per-200 ms); does not transcribe |
| `mic_record_and_play` | Records, then plays it back through the speaker |
| `mic_get_audio` | Returns a short downsampled mono WAV as an MCP resource |
| `play_tone` | Plays a tone (Hz, ms, volume) |
| `sing` | Sings `koe` notation; needs the stackchan-voice TTS engine |
| `show_message` / `hide_message` | Shows a short message in a speech balloon on the robot's screen |
| `show_face` | Puts the face back, whatever replaced it |
| `show_qr` | Shows a QR code for an http(s) link. Refuses anything else — a `javascript:`, `data:`, wifi-join or plain-text code would lend the robot's trust to something the person scanning it cannot see |
| `get_robot_info` | Reports MOD version, available hardware, the capture policy and the device's limits |
| `restart_robot` | Soft reboot — **leaves the screen dead until a manual power-cycle** (see below) |
| `get_power_registers` | Read-only AXP2101 rail and status registers, for diagnosing a dead display |
| `get_mic_gain` / `set_mic_gain` | Read and set the ES7210 preamp gain. Registered **only** where the ADC is reachable — not on CoreS3, where the firmware holds it, so these normally do not appear |

It also replaces the face with one that draws a real smile for `HAPPY` (the stock mouth ignores emotion) and reports
touches on the face area as `touch` events with screen coordinates.

## Device limits worth knowing

Measured on an M5StackChan CoreS3 running v1.1.0:

- **A large response body does not just fail — it takes the HTTP server down with it.** Bodies up to ~28 KB are
  served repeatably and ~56 KB reliably kills it; the threshold between those is unmeasured. Photos are therefore
  budgeted against 28 KB *on the wire* (base64 included), colour uses a 3-3-2 palette rather than truecolour,
  base64 is written straight into the response buffer, and the server restarts its listener if the accept loop
  dies.
- **A software restart leaves the display dead** until the robot is physically power-cycled (hold power until off,
  then press again). A hardware reset — the bottom reset button, or esptool — is safe. The host's own MOD manager
  calls `System.restart()`, so installing a MOD through it has the same effect.
- **Screen touch reaches a MOD only through the face**: the firmware does not hand it over, and opening the touch
  controller directly is refused (`duplicate address`) because the UI already holds it. The custom face installed
  by this MOD reports touches on the face area instead.
- **No A/B/C buttons exist** on this hardware; only `power`. The CoreS3 target's virtual buttons are compiled out.
- `say_message` returns only after playback finishes, which can take tens of seconds for a long sentence.

## Getting it running

Full path from a robot still in its box — firmware, preferences over BLE, the capture policy, build and
install — is in **[docs/getting-started.md](docs/getting-started.md)**. It is all hands-on-the-device work.

If the robot already runs stack-chan v1.1.0 and has its `mcp.token` set, the short version is:

```sh
# Moddable SDK 9.0.0 exactly - the device rejects a MOD whose XS version does not match the host
MODDABLE=~/moddable STACKCHAN=~/stack-chan scripts/build.sh
STACKCHAN_PORT=/dev/cu.usbmodem1101 scripts/install.sh
```

The archive goes to the `xs` partition at `0xfa0000` (256 KB) and replaces whatever MOD was there. `POST /mcp`
rejects every request until `mcp.token` is set, which is a BLE operation — see the guide.

## Try it

```sh
STACKCHAN_HOST=192.168.1.20 STACKCHAN_TOKEN=... scripts/mcp.sh '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Register it with Claude Code:

```sh
claude mcp add --scope user --transport http stackchan http://<robot-ip>:8080/mcp --header "Authorization: Bearer <token>"
```

## Moving it to another network

Wi-Fi credentials are ordinary preferences, so Settings mode rewrites them like any other. Put the password in a
gitignored `.env` at the repository root rather than on the command line, and reference it:

```sh
uv run --with bleak scripts/set-prefs.py wifi.ssid=<new-network> wifi.password=@env:WIFI_PASSWORD
```

Start the script first - it scans for up to 150 s - then press the bottom reset button, tap the gear on the 3 s
splash, and leave the Settings screen open. Press reset again afterwards *without* touching the screen, so the MOD
reloads.

The robot joins the new network on that boot. Its address changes, and nothing announces the new one: mDNS does not
work on this firmware. Find it by its MAC in the ARP table and re-run the `claude mcp add` above, because a client
registered against the old address simply stops working.

## Driving it from a Cowork cloud session

A cloud session cannot reach a LAN address. The route that works without exposing the robot is the Claude
Desktop bridge, whose proxy runs on your own machine — **[docs/remote-access.md](docs/remote-access.md)** has
the config, the three things that cost time, and what it costs, including that the token crosses your LAN in
cleartext on every call.

## Watching for events

The robot cannot push: there is no SSE on this firmware, and MCP's notification mechanism would need a
stream the HTTP layer cannot produce. So watching means asking repeatedly — and doing that from inside a
conversation costs a tool call and a turn for every empty answer.

`scripts/watch-events.py` moves the waiting into a process instead. It blocks in `wait_for_event` (so
latency is a round trip, not a poll interval), pulls the backlog by sequence number after each event so
bursts and gaps are covered, and prints one line per event:

```sh
STACKCHAN_HOST=192.168.1.20 scripts/watch-events.py
2026-09-17T07:30:01 watching from seq=41
2026-09-17T07:30:12 touch-panel gesture=forwardSwipe position=-50 intensity=3 seq=42
2026-09-17T07:31:44 unreachable: robot not answering
```

It also prints state changes, because anything watching only for event lines cannot otherwise tell a
quiet room from a dead script. The bearer token is never handled by it — `scripts/mcp.sh` fetches it
from the OS keychain per call.

## Checking it still works

A build proves the JavaScript compiles, and a tool call can return success while the head never moves.
`scripts/selftest.py` runs the checks that catch that: it asserts consequences rather than status — a
pose call that returns before its own duration has elapsed fails, a gaze that leaves the head pointing
straight ahead fails, a photo whose encoded size is over the body budget fails — and it fails if the
robot serves a tool no check exercises.

```sh
STACKCHAN_HOST=192.168.1.20 scripts/selftest.py          # read-only checks; changes nothing
STACKCHAN_HOST=192.168.1.20 scripts/selftest.py --all    # also visual, motion, audio and capture
scripts/selftest.py --list                               # what it would run, no robot needed
```

Only the read tier runs by default, because the others light LEDs, turn the head, make noise and use the
camera. `--json` prints one machine-readable report. `restart_robot` is never run by any flag: on this
hardware a software restart leaves the screen dead until someone power-cycles it by hand.

## Collecting diagnostics

`scripts/diagnose.py` writes one read-only bundle — health, robot info, input capabilities, power
registers, head pose, recent events, the tool list, HTTP conformance probes, and the local repo state
with file hashes — into `build/diagnostics-<timestamp>/`:

```sh
STACKCHAN_HOST=192.168.1.20 scripts/diagnose.py
```

Every file is passed through a redaction step first, so the bundle is safe to attach to an issue. A robot
that does not answer is a finding, not a crash: the bundle is still written, and says so.

## Picking expressions by hand

Comparing two expressions by watching a timed sequence is miserable, so `scripts/panel.py` serves a small local page
instead: a button per emotion at each intensity, fields for a message and for speech, and a live readout of what the
robot has on screen.

```sh
STACKCHAN_HOST=192.168.1.20 scripts/panel.py      # opens a browser; --no-open to just print the URL
```

It binds to `127.0.0.1` only, and the browser never sees the bearer token — the page posts to the local server,
which calls the robot through `scripts/mcp.sh`. A fixed action allowlist keeps it a review tool rather than a
general robot-control surface: no camera, no microphone, no restart.

## Reacting to events

`scripts/react.py` pairs input events with small routines, so the robot does something when nobody is
talking to it:

```sh
scripts/react.py examples/rules.json --events-from examples/captured-events.txt   # offline, no robot
STACKCHAN_HOST=192.168.1.20 scripts/react.py examples/rules.json                  # dry run
STACKCHAN_HOST=192.168.1.20 scripts/react.py examples/rules.json --act            # for real
```

Rules are data: a rule matches event fields by equality and names actions from a fixed vocabulary, so
there is no expression to evaluate, and a typo is refused at load rather than silently never matching.
The vocabulary covers the face, the LEDs, the head, speech and tones — and deliberately excludes the
camera and microphone, so a background process cannot become a capture trigger nobody sees. Nothing
reaches the robot without `--act`, every rule has a minimum interval, and the run as a whole has an
actions-per-minute ceiling.

## Troubleshooting

**The screen is blank but the robot answers MCP calls.** Two different failures, and the backlight tells them
apart. If the panel is **dark**, display initialization failed after a warm reset: pulse EN with
`STACKCHAN_PORT=<port> scripts/reset.sh 4` (`scripts/install.sh` sends two of those after flashing), and if it
stays dark, power-cycle by hand — hold the power button until the robot powers off, then press it again. A pulse
that works twice can fail on the next attempt and a later one can succeed where an earlier one did not, so more
pulses is a reasonable response to a dark screen. If the panel is **backlit but empty**, the display has stopped
rendering while the app runs on; the bottom reset button clears it. In both cases read the uptime from
`get_robot_info` before looking for a crash: continuous uptime means nothing restarted, so there is no reboot to
explain. Everything except the display keeps working meanwhile. See `docs/device-notes.md`.

**`esptool` cannot connect** (`No serial data received`). The app can wedge the USB peripheral. Start the flash and
press the bottom reset button while esptool retries.

**A tool call hangs and the robot stops answering.** Something produced a response larger than the device can send,
which takes the HTTP server down. The server restarts its listener automatically, backing off from 2 s to a minute
and never giving up; if it cannot bind three times running it lights one LED purple, so a robot that looks fine but
answers nothing is worth a glance before you assume the network. If it does not come back, reset the robot. Report
it, since a tool should refuse an oversized result rather than attempt it.

**Recordings sound almost silent.** They are: the capture path is about 30 dB quiet on this hardware, for reasons
not yet established (the ES7210's analog preamp has only 4.5 dB left to give, so it is not the cause). `listen`
`mic_listen` reports levels corrected for the measured offset, and the recording tools apply software gain by default.

## Development

```sh
scripts/check.sh   # lint, format, syntax, and the example rules; no robot needed
STACKCHAN_HOST=<robot-ip> scripts/selftest.py --all   # the checks that need hardware
```

Please read [CONTRIBUTING.md](CONTRIBUTING.md) — the short version is that a change should be tried on a real robot,
nothing may throw out of a handler, and responses must stay small.

## Operating it from an assistant

The MCP tools tell an assistant what it *can* do; they do not teach it how to behave with a physical robot. This
repository also ships a Claude skill for that — which tool to reach for, the hazards, recovery when the robot stops
responding, and how to report physical outcomes honestly rather than assuming a successful call meant something
visibly happened.

It is packaged as a Claude Code plugin, served from this repository as its own marketplace:

```sh
/plugin marketplace add yaniv-golan/stackchan-mcp-mod
/plugin install stackchan-robot@stackchan-robot-marketplace
```

Or, from a local clone:

```sh
/plugin marketplace add ./stackchan-mcp-mod
/plugin install stackchan-robot@stackchan-robot-marketplace
```

**The plugin installs the skill, not the robot.** The tools themselves come from the MOD on the device, which is
registered separately — the skill describes tools you will not have until you do. The plugin ships a command that
does it for you:

```
/stackchan-robot:setup
```

It finds the robot by MAC in the ARP table (or takes an address), checks that `GET /health` answers before
registering anything, and passes the token straight from the macOS Keychain, so it never appears in the
conversation. By hand, it is:

```sh
claude mcp add --scope user --transport http stackchan http://<robot-ip>:8080/mcp --header "Authorization: Bearer <token>"
```

That step is not folded into the plugin because there is nothing correct to put in it. A plugin manifest is a
static file shared by everyone who installs it, while the address is whatever DHCP handed *your* robot and the
token is yours alone. Manifests do support `${VAR}` expansion, but the first run of a fresh install would have
both unset, and what happens then is not specified.

To use it without the plugin machinery, copy the skill folder straight in:

```sh
cp -r stackchan-robot/skills/stackchan-robot ~/.claude/skills/
```

Both the skill and its packaging were produced with dedicated tooling:

- **[skill-creator-plus](https://github.com/yaniv-golan/skill-creator-plus)** drafted and iterated
  [`stackchan-robot/skills/stackchan-robot/SKILL.md`](stackchan-robot/skills/stackchan-robot/SKILL.md).
- **[skill-packager](https://github.com/yaniv-golan/skill-packager-skill)** generated the plugin and marketplace
  manifests from [`skill-packager.json`](skill-packager.json).

## Working notes

[`docs/device-notes.md`](docs/device-notes.md) is the bring-up log for this MOD: the build toolchain, the measured
device limits, the firmware bugs found along the way (an oversized response kills the HTTP server; a software
restart kills the display), the unexplained microphone deficit, and the approaches that did not work.

## Related

- [stack-chan](https://github.com/stack-chan/stack-chan) — the firmware this runs on, and its MOD gallery
- [Moddable SDK](https://github.com/Moddable-OpenSource/moddable) — the JavaScript engine and build tools
- [Model Context Protocol](https://modelcontextprotocol.io) — the protocol the robot speaks

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). `mod/mcp-server-rich.js` is derived from the stack-chan
firmware (Apache-2.0); the file header lists what changed. Changes are recorded in [CHANGELOG.md](CHANGELOG.md).
