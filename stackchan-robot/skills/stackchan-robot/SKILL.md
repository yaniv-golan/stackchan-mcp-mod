---
name: stackchan-robot
description: Operate a Stack-chan desk robot through its MCP tools — take photos, listen to the room, speak, move the head, light the LEDs, show messages and react to touch. Use whenever a request involves what the robot should see, hear, say, show or do, when interpreting what the robot sensed, or when the robot stops responding and needs recovery. Covers safe operation of real hardware: what the device cannot do, which call can leave it needing a human, and how to report physical outcomes honestly.
license: Apache-2.0
metadata:
  version: 0.2.0
compatibility: Requires the stackchan-mcp-mod MOD installed on an M5StackChan CoreS3 and registered as an MCP server.
---

# Operating a Stack-chan robot

You are driving a physical object on someone's desk. It has a camera and a microphone pointed at a room, servos
that move a head, and a speaker. Everything you do is visible or audible to whoever is sitting there, and some of
it cannot be undone from here — one tool call leaves the screen dead until a person walks over and power-cycles it.

The MCP tool descriptions tell you what each call does. This is about how to use them well.

## Report what you know, not what you assume

A tool result tells you the call succeeded, not that the robot did anything the person noticed. During development
of this MOD, tool calls returned success while the screen was dead for an hour. Distinguish these in what you say:

- **Verified by the result**: a photo came back, an event was recorded, levels were measured.
- **Reported by the device**: the head moved, the LEDs lit, speech played.
- **Only the person can confirm**: anything on screen, anything audible, anything that moved.

When the outcome matters and you cannot verify it, ask — briefly. "Did it actually move?" costs one line and is
how you find out the robot is wedged. Never write "the robot is now smiling at you" when all you know is that
`set_emotion` returned ok.

## Before a session

Call `get_robot_info` once. It reports the MOD version, which hardware is present, and device limits, and it
confirms the robot is reachable. If tools start failing mid-session, call it again: an unreachable robot and a
broken tool look identical from here.

## The camera

Default to grayscale; it is a third the size and always works. Colour is a 256-colour palette image at the same
small size. Anything larger is refused before the camera is touched, because a response that large would take the
robot's HTTP server down.

Capturing briefly pauses the head touch strip, and the frame is whatever the head is pointed at — if the photo
shows a ceiling or a wall, move the head and take another rather than describing a bad frame.

**Say what you are about to do.** A camera in someone's room should not fire silently. `show_message` on the
robot's screen before capturing is cheap and honest, and it also tells you the display is alive.

## The microphone

Two things shape every use:

- **`listen` measures loudness. It does not transcribe.** You will get RMS, peak and per-200 ms slices. Use it for
  "is anyone talking", "did something just happen", "is the room quiet" — never claim to know what was said.
- **This hardware captures about 30 dB quiet.** The tools already correct for it: levels are reported with the
  offset applied, and returned audio gets software gain. So trust the qualitative label ("quiet", "conversation
  level") over the raw dBFS number, and do not conclude the room is silent from a low reading alone.

Prompt before recording. The recording tools put "Listening..." on screen automatically, but if you want someone to
say something specific, `show_message` first so they know when to start.

Keep clips short. Recordings are large, and `get_recorded_audio` has to downsample to fit.

## When a capture is refused

Some robots run with `mcp.capture=armed`, which means the camera and microphone work only for a few minutes after
someone physically swipes the robot's head. If a capture tool returns that it is disarmed, do not retry in a loop
and do not look for a way around it — there isn't one, by design. Ask the person with the robot to swipe its head
strip or press "Arm camera" in its drawer, then try again. On a robot set to `off`, the capture tools are simply
absent from the tool list.

## Speech

`say_message` returns only after playback finishes — a sentence can take ten to thirty seconds, during which
nothing else happens. Write one short sentence rather than a paragraph, and do not queue several in a row.

The voice depends on the configured engine. `sing` needs the stackchan-voice engine specifically; on other engines
it fails cleanly, which is informative rather than broken.

## Head movement

Poses are absolute degrees: yaw positive is the robot's left, pitch runs from -90 (up) to 0 (level). Out-of-range
values are clamped and the result says so — read it, because a clamped move is not the move you asked for.

Movement is the one thing that can catch fingers or knock something over. Before a large movement, especially if
you are about to sweep to an extreme, say what will happen. Prefer a few tens of degrees over full range.

`set_head_pose` holds torque only for the duration of the move unless you pass `hold`. Leaving torque engaged makes
the servos hold position and stay warm; release it when you are done positioning. `look_at` starts continuous gaze
tracking that keeps running until `look_away` — remember to stop it, or the head will keep drifting toward a point
long after the task is over.

## Sensing what happens around the robot

Events accumulate in a small ring buffer: head-strip gestures, recognized IMU motions, the power button and screen
touches with coordinates. Two ways to use them:

- **Poll**: `get_recent_events` with `since_seq` from the previous call, so you see only what is new.
- **Block**: `wait_for_event` when you have just asked the person to do something. It waits up to 30 seconds and
  returns cleanly on timeout, which is a normal outcome, not a failure.

The IMU only reports recognized motions (shake, fallen over) — not raw orientation. The head strip reports
gestures, not positions. Screen touches are only reported for the face area.

## Watching for activity over time

The robot cannot call you: there is no push channel, no subscription, and `GET /mcp` deliberately returns 405. So
watching means asking repeatedly, and the way to do that cheaply is one long wait at a time:

- Call `wait_for_event` with a **long** `timeout_ms` (up to 45 s). It returns the instant something happens, so a
  long wait costs nothing in responsiveness — it only avoids a stream of empty polls. A timeout is a normal
  outcome, not an error; call it again.
- Between waits, `get_recent_events` with `since_seq` catches anything that landed in the gap. The robot keeps the
  last 64 events, so nothing is lost even if you are away for a while — only your *reporting* lags.
- Do not poll `get_recent_events` in a tight loop. It answers instantly, which makes it tempting, and it is pure
  waste next to a blocking wait.
- **If you are watching for more than a few minutes, get out of the conversation entirely.** With the repository
  to hand, `STACKCHAN_HOST=<ip> scripts/watch-events.py` prints one line per event and nothing while idle, so it
  can run under a background monitor: empty waits then cost no tokens and no turns, and only real events reach you.
  It also prints a line when the robot stops answering, so silence genuinely means "nothing happened".

**Never go looking for the robot's credentials.** If you find yourself wanting the bearer token — to run `curl` in
a shell, say — stop: reading it out of a client configuration file is indistinguishable from credential theft, and
a sensible sandbox will block it. You do not need it. The MCP tools already carry it, and this project's
`scripts/mcp.sh` fetches it from the OS keychain at call time, so a shell poller can use that script without the
secret ever being visible. Ask the person for a route rather than searching their files for one.

## What can go wrong, and what to do

| Symptom | What it means | What to do |
|---|---|---|
| Calls hang, then stop working entirely | A response exceeded what the device can send and took the server down | Wait ~10s for the listener to restart; if it does not, the person must reset the robot |
| Screen blank, tools still answer | Either display init failed after a warm reset, or the display stopped rendering mid-session; neither is your fault | Ask whether the screen is dark or lit-but-empty, and call `get_robot_info`: continuous uptime means nothing crashed. A dark panel needs a power-button cycle, a lit one the bottom reset button. No tool can fix either |
| A tool reports the camera or mic is busy | Another capture is in flight | Wait and retry once; do not hammer it |
| `sing` fails with "does not support singing" | Wrong TTS engine configured | Expected; use `say_message` |
| Head did not move but the call succeeded | Torque released too early, or something is blocking it | Retry with `hold: true` and ask the person to look |

With the repository to hand, two scripts answer "is it me or the robot?" faster than tool calls can.
`STACKCHAN_HOST=<ip> scripts/diagnose.py` writes a read-only bundle — health, robot info, power registers, the
tool list, HTTP conformance — that is safe to paste into an issue. `scripts/selftest.py` checks the tools still do
what they claim; its `--all` tiers move the head and make noise, so ask the person first.

**Do not call `restart_robot`.** It reboots in software, and on this hardware that leaves the display dead until
someone physically power-cycles the robot. The tool requires an explicit acknowledgement for exactly this reason.
If a reboot is genuinely needed, ask the person to press the reset button instead — a hardware reset is safe.

## Composing behaviour

The robot is more engaging when tools are combined with a beat of timing, rather than fired individually.

**Look and report**: point the head where you want to see (`set_head_pose`), take a photo, describe it. If the
frame is wrong, adjust and retake instead of apologising for a bad picture.

**Ask and wait**: `show_message` with the question, `wait_for_event` for a touch, or `listen` for a response.
Give the person time to react — a 2-second window is not enough for someone to look up and act.

**React to what happened**: on a touch or a shake, an emotion plus a short line plus a small head move reads as one
reaction. Three tool calls, one moment.

**Idle presence**: `look_at` a point near the person for gaze tracking, and remember to `look_away` afterwards.

Emotions are free and instant — use them as punctuation. `HAPPY` draws a real smile with this MOD.

## Gotchas

- Tool success is not physical success. The screen can be dead while every call returns ok.
- A photo costs a couple of seconds and pauses touch; do not poll the camera in a loop.
- `say_message` blocks; a long sentence blocks for a long time.
- Gaze tracking persists until stopped.
- Loud is not loud: read the qualitative level, not the raw dBFS.
- Clamped motion values are reported in the result — read them before claiming the pose you requested.
- The person can see the screen. Anything you put there with `show_message` stays until it times out or you hide it.
