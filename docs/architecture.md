# Architecture

How this repository fits together, for a developer or coding agent who has five minutes and has not
read all 15 modules. Constraints and the tool list are documented in [`AGENTS.md`](../AGENTS.md) and
[`README.md`](../README.md) — this file does not repeat them, only links to them where relevant.

## What runs where

This repository builds a **MOD**: a JavaScript archive (`mod.xsa`) written to the `xs` flash partition
of an M5StackChan CoreS3, and loaded by the **host firmware** (stack-chan v1.1.0) at boot — no firmware
rebuild involved. The host owns everything hardware-adjacent (servos, camera, microphone, display,
Wi-Fi, preferences) and hands the MOD a single **capability object** (called `robot` in this codebase,
typed as `StackchanContext` in the firmware's `host/app/capabilities.ts`) with namespaced APIs:
`robot.face`, `robot.motion`, `robot.audio`, `robot.lighting`, `robot.camera`, `robot.input`,
`robot.ui`, `robot.connectivity`. The MOD's job is to turn those APIs into MCP tools and serve them over
HTTP: `mod/mcp-server-rich.js` implements a JSON-RPC-over-HTTP server (`POST /mcp`), and everything else
in `mod/` either builds the tool list or supports that server.

## Boot sequence

From power-on to "tools available":

1. The ESP32 boots the stack-chan firmware; `host/app/main.ts`'s `main()` runs.
2. `main()` calls `loadAppBehaviors()`, which calls `resolveAppBehaviors(Modules, defaultBehavior, ...)`
   (`host/app/app-behavior-resolver.ts`). Because this repository's compiled MOD registers a module
   named `mod` (see manifest below), `resolveAppBehaviors` imports it and merges it onto the host's
   `defaultBehavior` with `mergeDefinedBehavior` — which replaces each *defined* key wholesale, not
   field-by-field. Since `mod/mod.js` exports `onContextCreated`, that one function entirely replaces
   the host's default `onContextCreated`. This is why `mod/mod.js` has to call the host default itself.
3. `main()` starts Wi-Fi (`startHostBootServices`), waits for `network.ready`, then builds the capability
   object with `createStackchanContext` (`host/app/compose.ts`) and calls
   `runContextCreatedBehaviors(appBehaviors, context, option)`, which invokes the merged behavior's
   `onContextCreated(context, option)` — i.e. `mod/mod.js`'s exported `onContextCreated(robot, option)`.
4. Inside it, in order:
   1. `onDefaultContextCreated(robot, option)` runs first (imported from
      `app-default-behavior/on-context-created`). This installs the stock drawer buttons (face style,
      emotion cycling, speech balloon, hand animation, camera preview, look-around, servo test, LED
      test, audio test, colour scheme), the IMU motion → emotion reactions, the `a`/`b`/`c` button
      handlers, and head-touch-strip "petting" (two swipes within 1.5 s → HAPPY with a head shake).
      Any failure here is caught and traced, not fatal.
   2. `createCapturePolicy(robot)` reads the `mcp.capture` preference once (see below).
   3. `createIndicators(robot)` builds the LED/chirp helpers used by the camera and microphone tools.
   4. `createEvents(robot)` sets up the input-event ring buffer, attaching to the head touch strip, IMU
      and buttons without clobbering the default behaviour's own subscriptions.
   5. The tool list is assembled: emotion and speech tools defined inline in `mod.js`, plus every
      `tools-*.js` factory.
   6. `robot.ui.setFace(createSmileFace({ onTouch: events.recordScreenTouch }))` replaces the face.
   7. `new MCPServer({ port: 8080, tools, ... })` is constructed, which reads `mcp.token` and starts
      listening.
   8. A drawer toggle button ("MCP Server") is added that shows/hides the endpoint URL in a balloon.
5. The robot is now reachable: `GET /health` always answers; `POST /mcp` answers once `mcp.token` is
   set (see [README.md](../README.md#configure-the-token)).

## Module map

| Module | Responsibility | What a reader would otherwise get wrong |
|---|---|---|
| `mod/mod.js` | Entry point. Runs the host default behaviour, builds `policy`/`indicators`/`events`, assembles the full tool list, installs the custom face, starts the server, adds the drawer toggle. | Also defines `set_emotion` and `say_message` inline — they are not in a `tools-*.js` file. |

| Module | Responsibility | What a reader would otherwise get wrong |
|---|---|---|
| `mod/mcp-server-rich.js` | The HTTP + JSON-RPC 2.0 server: connection limits, request-size/timeout guards, auth, method dispatch, binary-result encoding, listener self-restart. | It is a fork of the firmware's own `mcp-server.ts`, not a wrapper around it — see [design decisions](#design-decisions-worth-knowing). |

| Module | Responsibility | What a reader would otherwise get wrong |
|---|---|---|
| `mod/tools-motion.js` | `set_head_pose`, `look_at`, `look_away`, `get_head_pose`, `set_torque` — wraps `robot.motion.*`. | `get_head_pose` reads a cached pose that is only refreshed while a gaze or motion is active; it can be stale. |
| `mod/tools-appearance.js` | LED ring (`set_leds`, `blink_leds`, `rainbow_leds`, `leds_off`), face theme/mouth/eyes (`set_face_color`, `set_mouth_open`, `set_eye_open`), and speech balloons (`show_message`, `hide_message`). | Balloon tools live here, not in `tools-events.js`, because they are output (`robot.ui`), not input. |
| `mod/tools-events.js` | `get_recent_events`, `wait_for_event`, `get_input_capabilities`; owns the 64-entry input ring buffer and attaches to touch strip / IMU / buttons / screen touch. | Its own attempt to open a screen-touch reader (`createScreenTouch`) fails with `duplicate address` on the CoreS3 target, because Piu's own UI setup already holds that I2C device — the working path is `recordScreenTouch`, fed by the custom face (see `face-smile.js` below and `docs/device-notes.md`). |
| `mod/tools-camera.js` | `camera_take_photo`. Captures an RGB565 frame, encodes it as PNG, refuses anything over the response-size ceiling before capturing. | Registers zero tools if `policy.enabled` is false — the tool does not just error at call time, it does not exist. |
| `mod/tools-audio.js` | `mic_listen`, `mic_record_and_play`, `mic_get_audio` (microphone), `play_tone`, and `sing`, which registers only when the TTS engine can sing (speaker). | `mic_listen`/`mic_record_and_play` never return raw audio, only a loudness summary — `mic_get_audio` is the only tool that returns bytes, and only a downsampled mono clip that fits the size cap. |
| `mod/tools-mic-gain.js` | `get_mic_gain`, `set_mic_gain` on the ES7210 audio ADC. | Probes the I2C bus once at startup and returns no tools at all if a second client is refused — same `duplicate address` failure mode as screen touch, different chip. |
| `mod/tools-system.js` | `get_robot_info`, `restart_robot`. | `restart_robot` requires `accept_display_blank: true` because a software restart leaves the screen dead on this hardware (see `docs/device-notes.md`). |
| `mod/tools-power.js` | `get_power_registers` — read-only AXP2101 (PMIC) diagnostics via the host's `axp2101-power-capture` module. | Deliberately has no write tool; a bad register write can damage the board. |

| Module | Responsibility | What a reader would otherwise get wrong |
|---|---|---|
| `mod/capture-policy.js` | Reads `mcp.capture` (`open`/`armed`/`off`) once at boot and exposes `enabled`, `check()`, `describe()`. | `armed` cannot be turned on remotely by design — only a physical swipe on the head strip or the on-screen drawer arms it, and neither the mode nor arming is exposed as a tool. |
| `mod/indicators.js` | Lights the head-ring LED (and chirps, for the camera) for the duration of a capture, so use is visible even with a dead screen. | The LED write intentionally clobbers whatever pattern was previously set — that is the point, not a bug. |
| `mod/face-smile.js` | Replacement face: a vector mouth and eyebrows with a distinct shape per emotion (the stock mouth resizes a rectangle regardless of emotion, and three emotions have no visual at all), and the only route by which a MOD receives screen-touch coordinates. | Still delegates to the host's own `FaceBehavior`/`Eye`, so blinking, breathing, theming and TTS lip-sync keep working. Outlines are built once per quantized state and cached, because allocating on the render tick is what the firmware's own architecture tests forbid. |
| `mod/screen.js` | The single owner of the 320x240 panel: swaps content in via `setMain`, restores the face, and keeps `get_robot_info` honest about what is displayed. | The hide timer is not optional. Anything that replaces the face without a route back leaves the robot expressionless until the next tool call, and the person in front of it cannot tell why. |
| `mod/balloon.js` | Owns the speech balloon, including its font size. | The host compares only *geometry* when deciding whether to reuse an existing balloon, so changing font while one is up silently keeps the old font - and the reverse leaks a large font into the microphone's prompt. It hides first for that reason. |
| `mod/photo-view.js` | Turns a captured camera frame into a Piu container for the screen: a real RGB565 blit through `runtime-bitmap-port`, falling back to the firmware's coarse mosaic. | The firmware's own bitmap preview is not in any module map, so this replicates it from the pieces that are. The fallback is reported in the tool result, because 15 coloured rectangles is not a photo and a caller should know which it got. |
| `mod/robot-state.js` | What persists between calls — gaze, torque, what is on screen — for `get_robot_info` to report. | Deliberately does not track the LED ring: `indicators.js` clobbers it around every capture, so a shadowed value would be wrong exactly when someone was reading it to understand a capture. |
| `mod/font-probe.js` | Resolves a larger balloon font at boot and latches the answer. | Piu resolves fonts lazily, so an unknown name throws from inside a later layout pass where no MOD frame is on the stack — an uncaught exception, a reboot, a dead screen. `Style.measure()` forces the lookup onto our own stack, where it is catchable. |
| `mod/tools-renamed.js` | Refusing stubs under the pre-0.3.0 capture tool names. | They exist so a stale `permissions.ask` rule still matches a real tool and says what to change, instead of silently matching nothing. |
| `mod/png.js` | Minimal from-scratch PNG encoder for RGB565 camera frames (grayscale, 256-colour palette, or truecolour). | Uses uncompressed ("stored") deflate blocks — valid PNG, zero compression — because there is no deflate module available to a MOD; see [design decisions](#design-decisions-worth-knowing). |
| `mod/base64.js` | Writes base64 directly into a caller-supplied output buffer. | Exists specifically to avoid `Uint8Array.prototype.toBase64()`, which would produce an intermediate JS string. |

## How a request flows

1. A client connects and sends `POST /mcp`. `#handleConnection` first enforces
   `MAX_CONCURRENT_CONNECTIONS` (4) and starts a 10 s timeout that force-closes a stalled connection.
2. `#refuseEarly` rejects (closes the raw connection, no response body) any request with
   `Transfer-Encoding` set, or a declared `Content-Length` over 8 KB — before the body is read, because
   the HTTP layer buffers the whole body into RAM first and an unauthenticated oversized request could
   otherwise reboot the device.
3. For `POST /mcp`: the `Authorization` header is checked with the host's `authorizeMCPRequest` /
   `normalizeMCPToken` (`mcp-auth`, a host module, unmodified) against the `mcp.token` preference. A
   missing or wrong token drains the body and returns HTTP 401 — this is a plain HTTP error, not
   JSON-RPC. A non-JSON `Content-Type` gets HTTP 415 (browsers cannot set `application/json`
   cross-origin without a preflight this server does not implement).
4. `#handleMCPMessage` parses the JSON body. A parse failure or malformed envelope returns a JSON-RPC
   error (`-32700` / `-32600`). A message with no `id` (a notification) gets HTTP 202 with an empty
   body and no further processing.
5. The method is dispatched: `initialize`, `ping`, `tools/list` are handled directly; `tools/call` goes
   to `#handleToolsCall`. An unknown method is JSON-RPC `-32601`.
6. `#handleToolsCall` looks up the tool by name — unknown name is JSON-RPC `-32602` (this, and the
   error codes above, are protocol-level failures that never reach a tool handler). If the tool exists,
   its `handler(args)` runs. **This is where the error paths diverge**: if the handler *throws*, the
   throw is caught here and turned into an MCP tool result `{ content: [...], isError: true }` — a
   normal (HTTP 200, JSON-RPC success) response that the *MCP client* interprets as a failed tool call.
   JSON-RPC errors are reserved for protocol problems (bad method, bad tool name, parse failure);
   application/argument errors from a tool are always `isError` results, never JSON-RPC errors.
7. `normalizeResult` wraps a plain string return value as `{ content: [{ type: 'text', text }] }`; a
   tool may instead return the fuller `{ content, isError? }` shape directly (used for images/audio).
8. `#rpcResult` builds the JSON-RPC envelope, then scans `result.content` for a `dataBytes` field
   (an image, from `camera_take_photo`) or a `resource.blobBytes` field (a file, from `mic_get_audio`).
   If found, it calls `#jsonWithBinary` instead of a plain JSON response: this serializes everything
   *except* the byte payload as a JSON string, splits that string around a placeholder, and writes the
   base64 encoding of the bytes (via `base64.js`) directly between the two halves into one output
   buffer — so the binary payload's base64 form never exists as a separate JS string. Text-only results
   go through the plain `#json` path.

## How to add a tool

Three places, always together:

1. **A `tools-*.js` module** (existing or new) exporting a factory function that returns an array of
   tool objects, each shaped like:
   ```js
   {
     name: 'wave_hand',
     description: 'Wave the hand animation for duration_ms (default 500, clamped 200..2000).',
     inputSchema: {
       type: 'object',
       properties: { duration_ms: { type: 'integer', description: 'Milliseconds, 200..2000' } },
     },
     handler: async (args) => {
       const ms = clamp(args.duration_ms ?? 500, 200, 2000)
       robot.ui.setHandAnimation('clap')
       await wait(ms)
       robot.ui.setHandAnimation('none')
       return `Waved for ${ms}ms.`
     },
   }
   ```
   Throw a plain `Error` for bad input; the server turns it into an `isError` result. Clamp numeric
   input before it reaches hardware. State units, ranges, defaults and costs in `description` — a
   language model reads it, not a person reading source.
2. **`mod/manifest.json`** — add the new file's basename (no extension) to the `modules["*"]` array, or
   `mcrun` will not bundle it into the archive.
3. **`mod/mod.js`** — import the factory and splice its result into the `tools` array built inside
   `onContextCreated`.

## Design decisions worth knowing

- **The server is a vendored, modified copy of the firmware's `mcp-server.ts`, not the host's own
  instance.** The header comment in `mcp-server-rich.js` lists the changes: handlers may return image
  results, tools may declare a raw JSON Schema `inputSchema`, a throwing handler becomes an `isError`
  result instead of a JSON-RPC parse error, notifications get HTTP 202, `ping` is supported, and an
  unknown tool is `-32602`. None of that is a config flag on the host's version, and a MOD cannot patch
  firmware — vendoring a copy was the only way to get those behaviours.
- **PNG is encoded by hand in JS.** The GC0308 camera sensor has no JPEG mode (frames arrive as
  RGB565), the host firmware bundles no deflate/zlib module, and a MOD cannot add native code. `png.js`
  writes valid PNG using uncompressed ("stored") deflate blocks, trading file size for not needing
  compression at all.
- **Base64 is written straight into the response buffer.** `Uint8Array.prototype.toBase64()` would
  work, but it produces a JS string that then has to become part of a larger JSON string, then an
  `ArrayBuffer` — three large copies of the same data alive at once, which measurably starved the
  display driver on a colour photo. `base64.js` writes the encoded bytes directly at their final offset
  in the one output buffer that gets sent.
- **The custom face exists for two unrelated reasons**, bundled into one component because both need a
  face replacement: the stock mouth ignores `emotion` and just resizes a rectangle, so `HAPPY` never
  actually looked happy; and a MOD has no other way to see screen touches, because the touch chip is
  already held open by Piu's own UI setup and a second I2C client at the same address is refused (see
  `docs/device-notes.md`). Routing through the face's own Piu touch handlers sidesteps opening the chip
  a second time.
- **Capture tools are gated by a policy object (`open`/`armed`/`off`), not a boolean flag**, because the
  interesting property is that the policy *cannot be changed remotely*: no tool exposes it, and arming
  requires a physical swipe on the robot or a tap in its on-screen drawer. A flag a tool could flip would
  not provide that guarantee.
- **The default behaviours are invoked by the MOD itself** because a MOD's `onContextCreated` fully
  *replaces* the host's default one (see [boot sequence](#boot-sequence), step 2) rather than composing
  with it. Without calling `onDefaultContextCreated` explicitly, installing this MOD would silently
  disable head petting, IMU reactions, and the stock drawer entries.
