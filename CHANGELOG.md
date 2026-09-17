# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The self-test's event-wait check accepted only a timeout, so it failed whenever the head strip was touched
  during its 300 ms window — reporting a healthy robot as broken. Both outcomes are correct.

## [0.2.0] - 2026-09-17

Adds the operator scripts — a self-test that asserts physical consequences, a redacted diagnostics bundle, and an
event rules runner — raises the event wait ceiling, and closes a protocol conformance gap.

### Added

- `scripts/selftest.py` exercises the tools and asserts what they should have caused — that a pose call waits for
  its own motion, that a gaze actually turns the head, that a photo is a PNG inside the body budget — and fails if
  the robot serves a tool no check covers. Only the read-only tier runs by default; `restart_robot` never runs.
- `scripts/diagnose.py` writes a read-only diagnostics bundle (health, robot info, power registers, the tool list,
  HTTP conformance probes, local repo state) with every file redacted, so it can be attached to an issue.
- `scripts/react.py` runs small routines when the robot is touched, shaken or tipped over, from a rules file that
  is data rather than code. Its action vocabulary deliberately excludes the camera and microphone, it does nothing
  without `--act`, and it can be tried offline against `examples/captured-events.txt`.
- `scripts/watch-events.py` streams events as one line each, for use under a background monitor instead of polling
  from inside a conversation.
- `wait_for_event` accepts waits up to 45 s (was 30 s). A long wait costs nothing in latency — the call returns as
  soon as an event arrives — so this mainly removes empty round trips.
- `scripts/stackchan_client.py` and `scripts/stackchan_events.py` hold the one MCP client and the one
  event-following loop the Python scripts share. Neither handles the bearer token.
- `scripts/version.py` reads and sets the one version this project declares in six files, and `scripts/check.sh`
  fails when they disagree.
- `scripts/check.sh` also checks Python syntax and loads the example rules.

### Fixed

- The `MCP-Protocol-Version` header is validated, answering 400 for a version this server does not implement, as
  the specification requires.
- `get_input_capabilities` reports screen touch from boot rather than only after the first touch.

### Documented

- The display can stop rendering with no reset at all: the panel stays backlit and empty while every tool keeps
  answering and the uptime runs on unbroken. Only a hardware reset clears it, and the cause is unestablished. The
  backlight distinguishes it from the known dead-panel case, and a blank screen is therefore not evidence of a
  crash — read the uptime first. `scripts/selftest.py` warns before running its capture tier for this reason.
  See `docs/device-notes.md`.

### Known issues

These are limitations of the robot firmware and hardware, not of this MOD; they are documented here because they
shape how the tools behave. See `docs/device-notes.md` for the measurements behind each.

- A large response body never finishes sending and takes the HTTP server down with it. Bodies up to ~28 KB are
  served repeatably and ~56 KB is fatal; the threshold between them is unmeasured. Photos are budgeted against the
  encoded body size accordingly.
- Connections that stall before their headers complete are held by the firmware's HTTP layer, which does not hand
  them to MOD code; a few of them make the server unresponsive until they close. It recovers on its own and does
  not reboot.
- A software restart leaves the display dead until a manual power-cycle, and display initialization after any warm
  reset is unreliable. The host's own MOD manager restarts this way after installing a MOD.
- The microphone captures about 30 dB quieter than it should, for reasons not yet established — the ES7210's
  analog preamp has only 4.5 dB of unused range, so it is not the cause. Recordings are amplified in software and
  loudness thresholds are offset to match.
- Screen touch cannot be opened directly by a MOD (the firmware already holds the touch chip), and the CoreS3's
  virtual A/B/C buttons are compiled out of the platform build.

## [0.1.0] - 2026-09-17

First public release. The project's development history before this point is not published; this release is the
starting point of the public record.

### Added

- **MCP server MOD** for Stack-chan firmware v1.1.0 on M5StackChan CoreS3, served over Streamable HTTP on port 8080
  with bearer-token authentication from the `mcp.token` preference.
- **Default behaviors are preserved.** The MOD runs the host's `onContextCreated` before its own, so head petting,
  IMU reactions and the stock drawer entries keep working — unlike a MOD that simply replaces the behavior.
- **Face and speech**: `set_emotion`, `say_message`, `set_face_color`, `set_mouth_open`, `set_eye_open`.
- **Head motion**: `set_head_pose` (degrees, clamped to what the driver accepts), `look_at`, `look_away`,
  `get_head_pose`, `set_torque`.
- **Lighting**: `set_leds`, `blink_leds`, `rainbow_leds`, `leds_off` for the 12-LED head ring.
- **Input events**: `get_recent_events`, `wait_for_event`, `get_input_capabilities`, backed by a 64-entry ring
  buffer fed by the head touch strip, the IMU, the power button and screen touches.
- **Camera**: `take_photo`, returning a PNG encoded on the device in JavaScript — grayscale or a 3-3-2 palette
  colour image, since the sensor has no JPEG mode and the firmware bundles no deflate.
- **Audio**: `listen` (loudness only), `record_and_play`, `get_recorded_audio` (downsampled mono WAV as an MCP
  resource), `play_tone`, `sing`.
- **On-screen messages**: `show_message` and `hide_message`, and an automatic prompt while the microphone is open.
- **Security controls**: connection-level limits on the unauthenticated request path (8 KB body cap, no chunked
  encoding, a 10-second request timeout, at most 4 concurrent connections, and handled body rejections), a refusal
  to serve with an `mcp.token` shorter than 32 characters, LED and chirp indicators whenever the camera or
  microphone is used, and an `mcp.capture` preference (`open` / `armed` / `off`) that can require a physical touch
  on the robot before any capture. See [SECURITY.md](SECURITY.md).
- **Diagnostics**: `get_robot_info`, `get_power_registers`, and `get_mic_gain` / `set_mic_gain`, which register
  themselves only on hardware where the audio ADC is actually reachable (read-only AXP2101 rails and fault bits), and
  `restart_robot`, which requires explicit acknowledgement because a software restart leaves this hardware's
  display dead until a manual power-cycle.
- **A face that smiles.** The stock mouth ignores emotion, so `HAPPY` only squinted the eyes; this MOD installs a
  face that draws a real smile and reports touches on the face area, which is the only way a MOD can observe screen
  touches on this platform.
- **An operator skill for assistants**, packaged as a Claude Code plugin with this repository acting as its own
  marketplace (`/plugin marketplace add yaniv-golan/stackchan-mcp-mod`). It covers safe operation of the hardware
  rather than restating the tool descriptions.
- **Build and install scripts** (`scripts/build.sh`, `scripts/install.sh`, `scripts/mcp.sh`), including the
  double EN reset pulse that makes the display come back more often after flashing.
- **`docs/device-notes.md`**, the bring-up log: measured device limits, firmware bugs found, and approaches that
  did not work.

[0.2.0]: https://github.com/yaniv-golan/stackchan-mcp-mod/releases/tag/v0.2.0
[0.1.0]: https://github.com/yaniv-golan/stackchan-mcp-mod/releases/tag/v0.1.0
