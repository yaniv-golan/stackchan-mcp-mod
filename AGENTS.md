# Notes for coding agents

This repository is a **MOD**: a JavaScript app that runs on a desk robot (M5StackChan CoreS3) under the Moddable XS
engine, on top of stack-chan firmware v1.1.0. It serves MCP tools over HTTP so an assistant can drive the robot.

Read this before changing code. The constraints below are not stylistic — each one comes from something that broke
on real hardware.

## The rule that matters most

**You cannot verify a change from here.** A successful build proves the JavaScript compiles, nothing more. Tool
calls return success while the screen is dead, the head does not move, or the microphone records silence. If you
have not flashed the robot and had a human look at it, say the change is *unverified*. Do not report a fix as
working because the build passed or a tool call returned ok.

## Platform constraints

- **Moddable XS, not Node.** No npm packages at runtime, no `node:` imports (a specifier like `net` or `timer` is a
  *host* module compiled into the firmware), no filesystem, no threads. You can only import modules the host
  firmware already contains — check the stack-chan firmware manifests before assuming a module exists.
- **No native code.** If a capability needs a driver the firmware does not expose, a MOD cannot add it. Two
  documented examples: the screen-touch controller and the microphone ADC are both already open — Piu's UI setup
  holds the first, the host holds the second — and the I2C layer refuses a second client at the same address.
- **An uncaught exception or unhandled promise rejection reboots the device.** Wrap every event handler, timer
  callback and subscription body in try/catch; `.catch` every promise; release resources in `finally`. A
  `ReferenceError` thrown *inside* a catch block is the sneaky version of this — `scripts/check.sh` exists to catch
  it, because it costs a reboot rather than an error message.
- **A large response kills the HTTP server.** Not "fail" — the accept loop dies and the robot stays on the network
  with no MCP server. ~28 KB bodies are known good, ~56 KB is fatal, in between is unmeasured. Budget the
  **encoded body** (base64 is 4 bytes per 3) and refuse early, as `take_photo` does.
- **The device is small and slow.** Avoid holding several copies of a large buffer; base64 is written straight into
  the response buffer for this reason.

## Layout

| Path | What it is |
|---|---|
| `mod/mod.js` | Entry point: runs the host's default behaviors, assembles the tools, starts the server |
| `mod/mcp-server-rich.js` | HTTP + JSON-RPC server, derived from the firmware's own (Apache-2.0) |
| `mod/tools-*.js` | One module per capability area, each exporting a factory returning tool objects |
| `mod/capture-policy.js` | `mcp.capture` policy (open / armed / off); deliberately not changeable by any tool |
| `mod/indicators.js` | LED and chirp shown while the camera or microphone is in use |
| `mod/face-smile.js` | Custom face: a real smile for HAPPY, and the only route to screen touches |
| `mod/png.js`, `mod/base64.js` | Encoders written for this device's memory limits |
| `scripts/` | Build, install, check, configure, a raw MCP client, and the event watcher |
| `stackchan-robot/` | The Claude Code plugin: operator skill plus its manifest; `.claude-plugin/` at the root is the marketplace |
| `docs/architecture.md` | How the pieces fit and what happens at boot |
| `docs/device-notes.md` | The empirical record: measurements, firmware bugs, dead ends |

## Working on it

```sh
scripts/check.sh                                   # lint and format; no hardware needed
MODDABLE=~/moddable STACKCHAN=~/stack-chan make build
STACKCHAN_PORT=/dev/cu.usbmodem2101 make install   # writes the MOD and resets the robot
STACKCHAN_HOST=<robot-ip> make tools               # list what the robot now serves
```

Adding a tool means: write it in the right `tools-*.js` (or a new module), register the module in
`mod/manifest.json`, and add the factory to the list in `mod/mod.js`. Tool descriptions are read by a language
model, so state units, ranges, defaults and costs in them.

## Where a capability belongs: MCP tool or script?

Two surfaces reach the same robot, and the split is deliberate.

**MCP tools are the agent interface.** Anything an assistant does in the normal course of working with
the robot belongs here: they carry schemas and descriptions a model reads, and — the part that matters —
a client can permission them individually. `SECURITY.md` tells people to mark the capture tools
always-ask; that control exists *only* for MCP tools.

**Scripts are operator tooling**: build, flash, configure, diagnose, and stream. Things that are
inherently long-running, batch, or setup, and that should be a deliberate act rather than an incidental
one.

So: do not add a script that duplicates a tool. A `photo.sh` would route the camera through "may run
Bash", which is granted far more casually than a camera permission, and the injection defence the
security policy describes would quietly stop working. `scripts/watch-events.py` earns its place because
streaming is impossible over this transport, not because it is more convenient.

If multi-step choreography is wanted, prefer one script that performs one named routine over a general
robot-control CLI: a single reviewable action beats an arbitrary surface.

## Conventions

- Biome enforces formatting and lint; run `scripts/check.sh` before proposing a change.
- Clamp numeric inputs before they reach hardware; throw a plain `Error` for bad arguments and let the server turn
  it into an MCP error result.
- Comments should explain *why*, especially where the code works around device behaviour. Several functions look
  over-careful until you know what they prevent — keep those explanations.
- Record new hardware findings in `docs/device-notes.md` with the measurement, not just the conclusion.
- Update `CHANGELOG.md` under `Unreleased`.

## Things that will waste your time

These are settled; do not re-litigate them without new evidence on hardware:

- Opening the screen-touch chip or the microphone ADC from a MOD fails with `duplicate address` on this target.
  `tools-events.js` still tries, because the attempt succeeds on a platform where the host leaves the controller
  free; on CoreS3 it falls back to the custom face's touch callback, which is the working route.
- The CoreS3 has no A/B/C buttons, and its virtual ones are compiled out of the platform build.
- `System.restart()` leaves the display dead until a manual power-cycle.
- Display initialization after any warm reset is unreliable; this is not caused by MOD code.
- Recordings are about 30 dB quiet; the cause is unestablished (the analog preamp accounts for at most 4.5 dB of
  it), and a MOD cannot reach the ADC either way.
- Connections that stall before their headers arrive cannot be timed out from a MOD: the HTTP layer does not yield
  them to MOD code until the headers are complete.

## Security invariants

Do not weaken these without discussing it first; each exists because of a demonstrated attack or accident.

- Nothing may let a *tool* change the capture policy or arm the robot. The point of `armed` is that software alone
  cannot open the camera, which stops holding the moment a tool can flip it.
- Capture indicators (LEDs, chirp) must not be suppressible through a tool, and must not depend on the screen,
  which is often blank.
- The connection-level checks in `mcp-server-rich.js` run before the request body matters and before the token is
  checked. Keep them there: the body is buffered by the firmware, so anything that waits until after authentication
  is too late.
