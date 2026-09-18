# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The event loop survives a robot restart.** Sequence numbers begin again at 1 on every boot, and
  `follow()` only moved its cursor forward, so after a reboot `since_seq` sat permanently in the future and
  matched nothing: `watch-events.py` and `react.py` went silent for good while still reporting the robot
  reachable. A reported highest seq below the cursor is the tell, and the reset is now announced.
- **Events arriving during a blocking action are no longer stranded.** `wait_for_event` resolves only for
  events recorded after the call starts, and a timeout skipped the backlog pull entirely, so anything that
  landed while a `say_message` was playing stayed unread until some unrelated event happened to arrive - in
  a quiet room, never.
- **A refused tool call is no longer reported as an unreachable robot.** `text_of` returns `None` for an
  error result and a transport failure alike, so any refusal from `wait_for_event` would have stopped the
  loop pulling the backlog and put it to sleep against a robot that was answering perfectly.
- **`highest_seq` reads every answer the robot gives.** It matched `(highest seq overall: N)` but not the
  capital-H form written when there is nothing to return, so an empty answer read as 0.
- **A rule action with keys nothing reads is refused at load.** Every builder reads its arguments with a
  default, so a misspelled key was silently replaced by that default - `duration_mss: 9000` became
  `duration_ms: 2000` and the rule did something quietly different from what it said.
- **The MCP listener no longer gives up.** The accept loop was restarted at most five times, two seconds
  apart, then abandoned - so a listener that died left the robot pingable with nothing bound to port 8080
  until someone pressed reset. That is the silent death documented on 2026-09-17. It now backs off from 2 s
  to 60 s indefinitely, and the connection counter is reset on restart with a clamped decrement so handlers
  still in flight from the dead loop cannot drive it negative and silently raise the concurrency cap.
  **Flashed 2026-09-18. The recovery path is unverified**: nothing can force the accept loop to die, so the
  restart, the backoff and the connection-count reset have been reasoned about and built, not observed. A
  healthy robot reports no restarts, which is consistent with both a working fix and a dead one.
- **An over-cap connection gets `503` with `Retry-After`** instead of being accepted and closed with no
  body, which carried no information and looked like a crashed server. **Flashed 2026-09-18, still
  unverified**: reaching the connection cap needs five simultaneous slow calls, and the waiter cap now
  refuses the third `wait_for_event` before it can hold a slot, so the silent tools cannot get there.

### Changed

- **The loudness bands are drawn on raw RMS dBFS, anchored on measurements.** They used to add a 30 dB
  allowance that had been measured on a *peak* and applied to an *RMS* reading, so an empty room was
  labelled "conversation level" — while "silent" needed raw < −80 dBFS and "quiet" < −60, neither of which
  this microphone reaches. The anchors are in `docs/device-notes.md`: an empty room at −47.5/−51.4 dBFS RMS
  and speech at −42. The margins are thin, and the note says so. The per-slice row is dBFS rather than a
  linear 0–100 scale, which read 0 for every slice at any level this hardware produces. **Flashed
  2026-09-18; the labels themselves are unverified** — checking them means recording a room, which needs
  someone present to make the sounds and to consent to the recording.
- **A rules file can set `volume` on a `tone` action again.** Refusing unknown keys had taken that away.
  There is deliberately no default: omitted, the tool falls through to the robot's own speaker volume.
- **`blink` in a rules file takes `period_ms`, not `duration_ms`** - it is the flash period, and `leds` used
  the same name for a lifetime, which is how the shipped example came to start an alarm nothing ever
  stopped. A `blink` step with `duration_ms` is now refused at load, and the example turns its own LEDs off.
- **`camera_take_photo` offers only `160x120`.** The other two sizes were always refused by the body budget,
  in colour and grayscale alike, so the schema advertised two options that could never succeed. **Verified
  on hardware 2026-09-18**: the robot advertises `enum: ['160x120']`, and `240x176` is refused with `size
  must be one of 160x120` before the camera is touched.
- **`wait_for_event` allows two concurrent waiters.** A waiting call holds one of four connection slots for
  its whole timeout; a third caller is refused with a message naming `get_recent_events`. **Verified on
  hardware 2026-09-18**: three simultaneous waits gave two clean timeouts and one refusal, and a third
  consumer polled instead of reporting the robot unreachable.
- `react.py` takes `--for SECONDS` and `--wait-ms MS`; `watch-events.py` honours `STACKCHAN_RUN_FOR`. The
  deadline is enforced inside the event loop, because it yields only events and a quiet room never returns
  control to the caller — and the last wait is shortened to the time remaining, so `--for 15` stops at about
  15 s rather than at the end of a 45 s wait it could not interrupt. Verified on hardware: 15.8 s.
- `get_robot_info` reports a listener restart count and the worst run of consecutive failures when they are
  not zero. **Flashed 2026-09-18**; a freshly booted robot correctly reports neither, which the self-test
  asserts. A non-zero value has not been observed.

### Removed

- **The pre-0.3.0 capture tool aliases.** They existed so a user with stale `permissions.ask` rules on the
  old names got a loud failure rather than a silent bypass; there are no such users and no such rules, so
  four refusing stubs sat in every `tools/list` for nothing. **Verified on hardware 2026-09-18**: the robot
  serves 29 tools, `tools/list` is 16,125 bytes, and `scripts/selftest.py` passes its own coverage check
  again — it had been failing against the unflashed device, which was the suite being ahead of the robot.

### Added

- **The robot shows when its MCP server cannot bind.** Three consecutive failures light one LED purple,
  re-applied every 30 s so a capture clearing the ring cannot erase it, and cleared by the first accepted
  connection. `get_robot_info` reports the restart count and the worst run of consecutive failures — both
  survive being asked about, unlike the flag itself. This is the shape of the 2026-09-17 failure: five loop
  ends in eight seconds with nothing ever bound. **Flashed 2026-09-18; the trigger path has never run.** A
  healthy robot lights nothing, which the self-test checks, but whether a bind failure throws on this
  firmware — which is what the counter counts — remains unestablished.
- Offline test harnesses for the two things no one could exercise by hand: `scripts/test-events.py` for the
  event-following loop and `scripts/test-rules.py` for the rules validator. Both run in `scripts/check.sh`.

- `/stackchan-robot:setup`, a plugin command that registers the robot with Claude Code: it finds the robot by MAC in the
  ARP table or takes an address, checks `GET /health` answers before registering anything, and passes the bearer
  token straight from the macOS Keychain into `claude mcp add` by command substitution, so the token never reaches
  the transcript.

### Documented

- **Why the dead listener never came back.** The 2026-09-17 note recorded "Nothing recovered it on its own"
  as unexplained; the explanation was already in the tree. Also records the measured `tools/list` size,
  contradicting two comments calling it near the body ceiling.
- **The operator skill, corrected against what the robot actually does**: that an assistant cannot do reflex
  timing and `scripts/react.py` exists for it, that `wait_for_event` only sees events recorded after it
  starts, that a tool error does not prove physical inaction, that a second driver duplicates reactions
  rather than stealing them, and `GET /health` as the unauthenticated liveness probe. Three numbers in it
  were wrong: grayscale is 4% smaller than colour rather than a third, `wait_for_event`'s maximum is 45 s
  rather than 30, and "nothing is lost even if you are away" holds only if the reader makes the `since_seq`
  call.
- **What bridging the robot to a remote client breaks**, and that `mcp.capture=off` — not `armed` — is the
  control to reach for: `armed` is a ten-minute window on the whole robot, not a per-call confirmation, so
  once the owner swipes for their own reasons any token holder can capture until it lapses.
- **A pre-existing LED bug**, in `docs/device-notes.md`: `indicators.js` blanks the whole ring after every
  capture, which erases the armed-capture indicator while `armed` is still true.
- **How to install the plugin so the skill you are editing is the one that loads.**
- **The MCP server can stop listening while the robot looks healthy.** The face draws, `ping` is clean, and port
  8080 refuses every connection - the inverse of the known display failure, and the refusal is what distinguishes
  it from the stalled-connection hang (which makes the server unresponsive rather than absent) and from a crash
  (which reboots the device and restarts the listener). Only a hardware reset recovered it. See
  `docs/device-notes.md`, which also records an untested hypothesis about idle client connections so it can be
  tested rather than assumed.
- **The plugin installs the skill, not the robot.** The tools come from the MOD on the device and are registered
  separately; the README said so 130 lines earlier under a different heading, so following the plugin section end to
  end left you with a skill describing 33 tools and none of them. It now says so in place, with the reason the
  registration is not bundled: a plugin manifest is shared by everyone who installs it, while the address is
  per-user DHCP and the token is a per-user secret.
- **Moving the robot to another network.** `wifi.ssid` and `wifi.password` are ordinary preferences, so
  `scripts/set-prefs.py` writes them over BLE like any other; the robot joins on the next boot. Verified on
  hardware. Worth knowing why it works, because there is a silent-failure path: `stored-wifi.ts` resolves the SSID
  as `options.ssid ?? readStoredWiFiPreference('ssid')` and `options` comes from the build config, so a firmware
  with Wi-Fi baked into its manifest would ignore the stored preference while the write still reported success.
  This build has no `wifi` in its config, so the preference is what boot uses. The robot's address changes
  afterwards and nothing announces the new one.

## [0.3.0] - 2026-09-17

Makes the screen worth looking at. Every emotion has a face of its own, the mouth opens while speaking instead of
curling deeper, on-screen text is legible across a room, and the panel can show a photograph or a QR code and find
its way back to the face afterwards. The four capture tools are renamed so that one permission rule covers all of
them.

### Breaking

- The four capture tools are renamed so they can be permissioned as one group: `take_photo` →
  `camera_take_photo`, `listen` → `mic_listen`, `get_recorded_audio` → `mic_get_audio`, `record_and_play` →
  `mic_record_and_play`. The old names remain registered as refusing stubs that name the replacement, so a
  stale `permissions.ask` rule fails loudly instead of silently matching nothing. **If you have the old names
  listed under `permissions.ask` alongside a broad allow rule for this server, upgrading without also updating
  those rules lets the camera and microphone fire with no prompt** — Claude Code does not warn about this,
  because its stale-rule check exempts tool names containing an underscore. See [SECURITY.md](SECURITY.md) for
  the new rule block and the Claude Code version it requires.

### Added

- **A face for every emotion.** The mouth is a Piu `Shape` with cached outlines rather than nine coloured
  rectangles, and each emotion draws its own path: smile and frown arcs, a pressed tense line for `ANGRY`, an
  asymmetric smirk for `DOUBTFUL`, a shiver wave for `COLD`, a small relaxed oval for `SLEEPY`, a wide pant for
  `HOT`. Eyebrows are new, one `Shape` per side, tilted and lifted per emotion and deliberately asymmetric for
  `DOUBTFUL`, because one raised brow is what makes a face look sceptical. Three of the eight emotions -
  `DOUBTFUL`, `COLD` and `HOT` - previously rendered exactly like `NEUTRAL`, and none of them moved the mouth.
- **The mouth opens rather than curling.** Above a threshold it becomes a filled lens: a top lip carrying the
  emotion's curve and a bottom lip pushed down by however far the mouth is open. Openness and expression are
  separate axes, so speaking no longer deepens a smile into a sag. All 12 lip-sync steps are kept; coarser
  quantization stair-steps speech.
- **`set_emotion` accepts an optional `intensity`**, quantized to three levels and held in the MOD, since the
  firmware's `FaceState.emotion` is a bare enum with nowhere to put a magnitude. Intensity drives bend range,
  mouth bow, stroke thickness and eyebrow weight together, and the result reports a word - subtle, normal,
  strong - rather than a rounded float.
- **`show_qr`** shows a QR code for an `http`/`https` URL of at most 300 characters, with the decoded host
  printed beneath it so a person can read where a code goes before scanning it. A long host is truncated from the
  **left**, because the registrable domain sits at the right end of a hostname and truncating the other way would
  show a deceptive prefix while hiding the part that matters.
- **`show_face`** puts the face back on the screen. `hide_message` cannot return from a photo or a QR code; the
  screen owner is what knows how.
- **`show_message` gains `size`** (`small` | `medium` | `large`, default `medium`). A boot-time probe resolves
  the larger fonts on the MOD's own stack, where Piu's lazy font lookup can be caught, rather than from inside a
  layout pass where the failure would reboot the device.
- **`camera_take_photo` gains `show_on_screen`** (default false), which displays the capture on the robot's own
  panel for about ten seconds. It blits the real RGB565 frame; where that is not possible it falls back to the
  firmware's coarse colour mosaic and the tool result says which one happened, because 15 coloured rectangles are
  not a photograph.
- **`get_robot_info` reports gaze, torque and what is currently on the screen**, which an assistant arriving
  mid-session cannot otherwise know.
- `scripts/reset.sh` pulses EN over USB with a settable pulse count, which is the first thing to try when the
  screen is black. The pulse used to exist only inside `scripts/install.sh`, so resetting a robot meant reflashing
  it; `install.sh` now calls this script rather than carrying its own copy. Pulses are spaced 6 s apart, because
  every pulse is a reboot and firing four in quick succession resets a robot whose display had just recovered.
- `scripts/panel.py` serves a localhost-only page for picking expressions by hand: a button per emotion at each
  intensity, message and speech fields, and a live state readout. It exists because comparing two expressions by
  watching a timed sequence is miserable. The browser never sees the bearer token - the page posts to the local
  server, which calls the robot through `scripts/mcp.sh` - and a fixed action allowlist keeps it from becoming a
  general robot-control surface.
- `scripts/selftest.py` gains a check per capture-tool stub, asserting each refuses and names its replacement, and
  a `tools/list` response-size guard: the encoded `tools/list` body is measured and the check fails above 24 KB,
  well below the size that has been observed to take the HTTP server down.

### Changed

- `mod/screen.js` is the single owner of the 320x240 panel: everything that replaces the face goes through it,
  and its hide timer is not optional. Content with no route back leaves the robot expressionless until the next
  tool call, with nobody in the room able to tell why.
- `sing` registers only when the speech engine exposes `streamKoe`, instead of always registering and failing
  when called.

### Fixed

- The self-test's event-wait check accepted only a timeout, so it failed whenever the head strip was touched
  during its 300 ms window - reporting a healthy robot as broken. Both outcomes are correct.
- `hide_message` reported the screen as showing the face whatever was actually on it, which became a lie as soon
  as a balloon could sit over a photograph. It now reports what the screen owner knows.

### Documented

- The head touch strip fires on its own when the USB cable runs to a laptop beside the robot: 64 events in 56
  seconds with nobody touching it, zero once moved away. Each phantom stroke runs the firmware's petting reaction,
  which draws a heart, moves the head and interrupts speech - so a robot that seems possessed is worth checking
  against its touch-panel events before anything else. See `docs/device-notes.md`.
- Attaching a serial logger resets this device on every port open, so an uptime that starts from zero is not
  evidence of an uncaught exception. The physical reset button recovers a blank display where EN pulses over USB
  are unreliable. See `docs/device-notes.md`.

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

[0.3.0]: https://github.com/yaniv-golan/stackchan-mcp-mod/releases/tag/v0.3.0
[0.2.0]: https://github.com/yaniv-golan/stackchan-mcp-mod/releases/tag/v0.2.0
[0.1.0]: https://github.com/yaniv-golan/stackchan-mcp-mod/releases/tag/v0.1.0
