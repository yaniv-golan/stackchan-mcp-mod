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
   refuse early, as `camera_take_photo` does.

Clamp every numeric input before passing it to hardware. Throw a plain `Error` for bad arguments; the server turns
that into a well-formed MCP error result.

## Tool design

Tools are consumed by a language model, so descriptions carry real weight. State units, ranges and defaults, and
say what a tool costs — that `say_message` only returns after playback, that `camera_take_photo` pauses the touch strip.
Where the hardware behaves surprisingly, say so in the description rather than leaving it to be discovered.

## Versioning and releases

**One version covers the whole project.** The MOD, the operator skill, the Claude Code plugin and the marketplace
ship together and are only ever tested together, so they carry the same number rather than three more numbers to
keep true.

That number is declared in six files. Read or change it with the script, never by hand — `scripts/check.sh` fails
when the six disagree:

```sh
scripts/version.py            # print it
scripts/version.py set 0.2.0  # rewrite all six
```

What the parts mean here, where the consumer of this software is usually a language model:

| Bump | For |
|---|---|
| Patch | A fix that leaves every tool's contract alone |
| Minor | A new tool, a new optional argument, or a description change that changes how a model would use a tool |
| Major | A tool removed or renamed, an argument's meaning changed, a preference key changed — anything that breaks an existing caller or install |

**Do not bump the version in a pull request.** Add your entry to `CHANGELOG.md` under `Unreleased` and leave the
number alone; bumping it is a release step, and six files are six conflicts when two branches both do it.

Cutting a release:

```sh
scripts/version.py set X.Y.Z
# rename the CHANGELOG's Unreleased heading to "## [X.Y.Z] - <date>" and add its link at the bottom
git commit -am "Release X.Y.Z"
git tag vX.Y.Z && git push --follow-tags
```

Then flash a robot, because `get_robot_info` reports the version the device was **built** with. Between a bump and
the next `scripts/install.sh` the source is legitimately ahead of the hardware; that is not drift.

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
