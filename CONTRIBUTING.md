# Contributing

Thanks for looking at this. It is a small project with an unusual constraint: almost nothing can be verified
without the hardware, so the bar for a change is "tried on a real robot", not "looks right".

## What you need

- An **M5StackChan CoreS3** running **stack-chan firmware v1.1.0**
- **Moddable SDK 9.0.0** exactly — the device rejects a MOD whose XS version does not match the host
- A **stack-chan checkout at tag v1.1.0**, for the platform configuration `mcrun` needs
- `uv` (for `esptool` and `pyserial`), and Node.js if you want to run the checks

No ESP-IDF is needed: this builds a MOD, not the firmware.

```sh
MODDABLE=~/moddable STACKCHAN=~/stack-chan scripts/build.sh
STACKCHAN_PORT=/dev/cu.usbmodem2101 scripts/install.sh
scripts/check.sh
```

## Writing MOD code

This is JavaScript for the XS engine, not Node. There is no npm, no `console.log` (use `trace('...\n')`), and the
available modules are the ones the host firmware already contains — you cannot add native code.

Two rules matter more than style:

1. **Nothing may throw out of a handler, timer or callback.** An uncaught exception or an unhandled promise
   rejection reboots the device. Wrap event handlers, always `.catch` promises, and release resources (`close()` a
   camera frame, `stop()` the camera) in `finally`.
2. **Watch the response size.** A large result does not merely fail — it takes the HTTP server down. Bodies up to
   ~28 KB are known good and ~56 KB is fatal. Estimate the **encoded** size before producing a large payload and
   refuse early, as `take_photo` does.

Clamp every numeric input before passing it to hardware. Throw a plain `Error` for bad arguments; the server turns
that into a well-formed MCP error result.

## Tool design

Tools are consumed by a language model, so descriptions carry real weight. State units, ranges and defaults, and
say what a tool costs — that `say_message` only returns after playback, that `take_photo` pauses the touch strip.
Where the hardware behaves surprisingly, say so in the description rather than leaving it to be discovered.

## Pull requests

- Say **what you ran on the device** and what it did. "Builds" is not enough.
- Keep a change to one concern; this project's history is full of interacting hardware quirks, and small commits
  make them separable.
- Update `CHANGELOG.md` under an `Unreleased` heading.
- If you discover a firmware or hardware behaviour, record the measurement in `docs/device-notes.md`. That file has
  saved more time than the code has.

## Reporting bugs

Include the firmware version, the MOD version (`get_robot_info`), what you asked for, what happened, and the serial
log if you have it. Note that opening the serial port resets the robot.
