<!--
Working notes from bringing up one M5StackChan CoreS3 with this MOD. Kept here because most of it is
about the firmware and the hardware, not about one robot: measured device limits, two firmware bugs, the
build toolchain, and what did not work. Device identifiers (IP, MAC, Wi-Fi name) are redacted, and the
local workspace path is written as ~/stackchan-workspace.
-->

# StackChan — working notes

Everything learned getting Claude to control this StackChan, so it doesn't have to be rediscovered.
Last updated 2026-09-16 (evening). Lives in `~/stackchan-workspace/` with `stackchan_set_prefs.py` and `factory-backup/`.

## Quick reference

```bash
# is it up? (no auth)
curl -s http://<robot-ip>:8080/health            # {"status":"ok"}

# raw MCP call (Accept header is required by Streamable HTTP clients; token from Keychain)
T=$(security find-generic-password -s stackchan-mcp-token -a stackchan -w)
mcp() { curl -s -X POST http://<robot-ip>:8080/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "Authorization: Bearer $T" -d "$1"; echo; }
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"set_emotion","arguments":{"emotion":"HAPPY"}}}'
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"say_message","arguments":{"message":"hello"}}}'

# Claude Code registration (user scope; restart Claude Code to load tools)
claude mcp get stackchan
claude mcp remove stackchan -s user

# set robot preferences over BLE (robot must be in Settings — see "Preferences")
cd ~/stackchan-workspace && uv run --with bleak stackchan_set_prefs.py            # mcp.token from Keychain
cd ~/stackchan-workspace && uv run --with bleak stackchan_set_prefs.py ui.language=en
cd ~/stackchan-workspace && uv run --with bleak stackchan_set_prefs.py tts.type=openai tts.token=@env:OPENAI_API_KEY
#   value refs: @env:NAME (from ~/stackchan-workspace/.env, else environment), @keychain:SERVICE (account "stackchan")

# serial log WITHOUT resetting: set dtr/rts False BEFORE open() (plain serial.Serial(port) resets the chip).
# A resilient logger that survives reboots is sketched under "Debugging speech".
# serial boot log (this one DOES reset over USB on purpose, capture 25 s)
uv run --with pyserial python -c '
import serial,time; s=serial.Serial("/dev/cu.usbmodem2101",115200,timeout=0.5)
s.dtr=False; s.rts=True; time.sleep(0.1); s.rts=False
end=time.time()+25; b=b""
while time.time()<end: b+=s.read(4096)
print(b.decode("utf-8","replace"))'
```

Physical controls (M5StackChan CoreS3 on stack-chan firmware):
- **Bottom button = reset/reboot.** Safest way to restart; lets you watch the splash.
- **Startup splash** `Stack-chan[・＿・]` shows **3 s** with a gear **Settings** button (`設定` in Japanese UI) at the bottom
  → tap immediately to enter Settings (BLE `STK`). Otherwise it auto-boots to the face + MOD.
- After boot, touching the screen opens a menu/drawer; the MCP MOD adds an entry that shows/hides the endpoint URL.
- A blank screen after boot was not a crash — `/health` and ping were fine. Tap the screen.
- Keep hands off the head while it's powered; servos power on at boot.

## Current state (2026-09-16)

| Item | Value |
|---|---|
| Hardware | M5Stack **M5StackChan CoreS3** (ESP32-S3 QFN56 rev v0.2, 16 MB flash, USB-Serial/JTAG) |
| MAC | `<robot-mac>` |
| LAN IP | `<robot-ip>` on the home Wi-Fi (DHCP reservation on the router) |
| USB serial port (this Mac) | `/dev/cu.usbmodem2101` |
| Firmware | **`stack-chan/stack-chan` v1.1.0**, target `m5stackchan_cores3` (host id string `9.0.0+stackchan.1`) |
| Installed MOD | MCP Server (from the v1.1.0 tag's MOD Gallery `mcp.xsa`) |
| MCP endpoint | `http://<robot-ip>:8080/mcp` (Bearer token) · `GET /health` → `{"status":"ok"}` |
| `mcp.token` | set 2026-09-16 (value in macOS Keychain `stackchan-mcp-token`) |
| Claude Code | registered user-scope as `stackchan` (HTTP, Bearer header in `~/.claude.json`) — ✔ Connected |
| Voice (TTS) | `tts.type=openai`, `tts.voice=alloy`, `tts.speed=1`, `tts.volume=0.5`; key = OpenAI **service-account** key in `~/stackchan-workspace/.env` (`OPENAI_API_KEY`, chmod 600) and stored on the robot as `tts.token` — ✅ English speech works |
| Factory backup | `~/stackchan-workspace/factory-backup/stackchan-factory-<robot-mac>-2026-09-16.bin` (+ `.sha256`) |

## Firmware options — the landscape

There are three unrelated firmware families. Pick one; they don't mix.

1. **M5Stack factory firmware** (what shipped). ESP-IDF, source in `github.com/m5stack/StackChan` (`firmware/`).
   App launcher with apps: `AI.AGENT` (XiaoZhi voice assistant), `AVATAR`, `DANCE`, `ESPNOW.REMOTE`, `SETUP`, app center, etc. Apps are mutually exclusive.
2. **`stack-chan/stack-chan`** (community, Moddable JavaScript). **← now installed.** Stable "host" firmware + swappable **MODs**
   (JS apps written to a separate flash partition — no reflash to change them). Officially supports M5StackChan CoreS3
   (the only target with mandatory on-device release testing). v1.1.0 released 2026-08-25.
3. **Custom ESP-IDF forks**, e.g. the `stack-chan-skill` (`~/.claude/skills/stack-chan-skill`) which adds a `REMOTE.AGENT`
   app to the M5Stack source and streams mic/speaker/camera over a WebSocket (`ws://<ip>:6001/stacky/device`) to a Bun
   "brain" server on the Mac (Deepgram STT/TTS + an LLM). Needs ESP-IDF v5.5.4 installed and a local build.
   **Not used** — incompatible with option 2.

## Factory firmware: no-flash control paths (verified in source, not tested on device)

### A. BLE GATT via the `DANCE` app — head, face, LEDs only

Only the `DANCE` app starts this server (`app_avatar` has it commented out). Advertised name **`StackChan`**.
Source: `firmware/main/hal/hal_ble.cpp`, `hal/utils/bleprph/bleprph.h`, `stackchan/json/json_helper.cpp`.

| Characteristic | UUID |
|---|---|
| Service | `e2e5e5e0-1234-5678-1234-56789abcdef0` (alt `e2e5e5ff-…` is used by Wi-Fi setup mode) |
| Motion | `e2e5e5e1-1234-5678-1234-56789abcdef0` |
| Avatar (face) | `e2e5e5e2-1234-5678-1234-56789abcdef0` |
| Config | `e2e5e5e3-1234-5678-1234-56789abcdef0` (app config / Wi-Fi setup) |
| RGB LEDs | `e2e5e5e4-1234-5678-1234-56789abcdef0` |

Each is a JSON write (max 2048 bytes). JSON keys the firmware parses:
- Motion: `yawServo` / `pitchServo` → `angle`, `speed`, `rotate`, `durationMs`, `spring` { `stiffness`, `damping` }.
  Angles are 0.1°: yaw `-1280..1280`, pitch `0..900` (center pitch ≈ 450).
- Avatar: `leftEye` / `rightEye` → `size` (-100..100), `rotation`, `weight` (0..100, eyelid openness), `x`, `y`; `mouth` → `size`, `weight` (openness).
- RGB: `leftRgbColor`, `rightRgbColor`, `leftRgbDuration`, `rightRgbDuration`.

Working Mac example (Python `bleak`): `github.com/yossitv/kawaii-home-studio` → `scripts/ble_state_demo.py`.
Example payloads:
```json
{"yawServo":{"angle":0,"speed":600},"pitchServo":{"angle":450,"speed":600}}
{"leftEye":{"size":-50,"rotation":0,"weight":60},"rightEye":{"size":-50,"rotation":0,"weight":60},"mouth":{"size":40,"weight":80}}
```
Limits: no camera, mic, speaker, or sensors. BLE is 1:1. ESP-NOW remote protocol (8-byte packet) has no face field.

### B. XiaoZhi "MCP endpoint" in the M5Stack phone app — the opposite direction

The app shows an MCP address like `wss://api.xiaozhi.me/mcp/?token=<JWT>` and "access point status: offline".
This is a slot on **XiaoZhi's cloud** where *your* MCP server connects **out** and offers tools that the *robot's cloud
voice AI* can call (e.g. `github.com/78/mcp-calculator` → `mcp_pipe.py`, env `MCP_ENDPOINT`). It does **not** let
Claude control the robot. "Offline" = nothing connected. The `token` in that URL is a live credential (~1 year expiry) —
never commit or paste it. (No longer relevant after flashing: XiaoZhi assistant is gone.)

## Flashing — what was actually done

Official route is the browser installer (Chrome/Edge, WebSerial): https://stack-chan.github.io/stack-chan/web/flash/
Done from the terminal instead, reproducing it exactly:

```bash
# esptool without installing anything globally
uvx --from esptool esptool --port /dev/cu.usbmodem2101 chip-id

# 1. release zip + checksum (sha256 b1fce38c…bc38 matched)
gh release download v1.1.0 -R stack-chan/stack-chan
shasum -a 256 stack-chan-firmware-v1.1.0.zip; cat stack-chan-firmware-v1.1.0.zip.sha256
unzip stack-chan-firmware-v1.1.0.zip   # tech.moddable.stackchan/m5stackchan_cores3/{bootloader,partition-table,xs_esp32}.bin

# 2. full backup first (≈100 s), then on-chip digest check
esptool --port /dev/cu.usbmodem2101 --baud 921600 read-flash 0 0x1000000 backup.bin
esptool --port /dev/cu.usbmodem2101 verify-flash 0 backup.bin

# 3. flash at the offsets from web/flash/manifest_esp32_m5stackchan_cores3.json
D=tech.moddable.stackchan/m5stackchan_cores3
esptool --chip esp32s3 --port /dev/cu.usbmodem2101 --baud 921600 write-flash \
  0x0 $D/bootloader.bin 0x8000 $D/partition-table.bin 0x10000 $D/xs_esp32.bin
```

Notes:
- The web installer uses `eraseAll: false` (see `web/src/services/esptool/esptool-adapter.ts`), so we didn't erase either.
- Side effect: the **ESP-IDF Wi-Fi credentials survived in NVS**, so the new firmware joined `<ssid>` without setup
  (log shows `No Wi-Fi SSID` from Moddable prefs, then `Connected to: <ssid>`). A full erase would lose that.
- Partition table (v1.1.0): `nvs 0x9000/0x6000`, `phy_init 0xf000`, `factory` app `0x10000/0xf90000`,
  **`xs` (MOD partition, type 0x40/1) `0xfa0000/0x40000`**, `storage 0xfe0000/0x10000`.
- Hardware reset over USB without entering download mode: open serial, `DTR=False`, pulse `RTS` (DTR maps to IO0 on
  the CoreS3's native USB).
- **Restore factory firmware:** `esptool write-flash 0 ~/stackchan-workspace/factory-backup/stackchan-factory-<robot-mac>-2026-09-16.bin`
  (byte-exact, includes the XiaoZhi account/Wi-Fi — treat the file as sensitive). Or M5Burner per docs.m5stack.com/en/StackChan.

### Boot log (healthy)

```
[main] checking mod override
Connected to: <ssid> / Got IP address: <robot-ip>
[main] TTS engine: stackchan-voice
[scservo] serial port=1 tx=6 rx=7 baud=1000000
[m5stackchan-servo] servo power on (true)
[main] app context created / app behaviors ready
Starting MCP Server mod … MCP Server started on port 8080
```

Capture it with pyserial (115200) after a reset — see `uv run --with pyserial` snippet pattern above.

## MODs — install without the browser

A MOD install is just writing the `.xsa` archive to the `xs` partition
(`web/editor/esptool-installer.mjs`: reads partition table at `0x8000`, finds type `0x40`/sub `1`, writes, verifies, resets).

```bash
esptool --chip esp32s3 --port /dev/cu.usbmodem2101 --after no-reset write-flash 0xfa0000 mcp.xsa
```
Remove a MOD: write 4096 bytes of `0xFF` at the same offset. Only one MOD archive at a time.

**Version gotcha:** use the `.xsa` from the **release tag**, not `main`. At v1.1.0 the gallery `mcp.xsa` header is
`VERS 17.8.0` (built with SDK 8.3.1); on `main` (Sep 2026) it's `17.8.2` (SDK 9.5.0), built for a newer host.
```bash
gh api 'repos/stack-chan/stack-chan/contents/web/mod-gallery/samples/mcp/mcp.xsa?ref=v1.1.0' -q .content | base64 -d > mcp.xsa
```

Gallery MODs (v1.1.0): Codex Voice, MCP Server, MediaPipe BLE, Stack-chan JUMP, UI playground. Catalog:
`web/mod-gallery/catalog.json`; each sample has `stackchan-mod.json` (targets, capabilities, artifact).
Building your own `.xsa` needs the Moddable SDK (or the web project editor).

## MCP Server MOD

- Source: `firmware/mods/examples/mcp/mod.js`, server class `firmware/host/modules/connectivity/mcp-server/`.
- Streamable HTTP, MCP protocol `2024-11-05`, methods `initialize`, `tools/list`, `tools/call`. Port **8080**.
- `GET /health` unauthenticated. `POST /mcp` requires `Authorization: Bearer <mcp.token>`; missing/wrong token → 401.
- **Installing a MOD disables default behaviors:** the host merges behaviors key-by-key
  (`firmware/host/app/app-behavior-resolver.ts`, `mergeDefinedBehavior`), so the MCP MOD's `onContextCreated` *replaces*
  `firmware/host/app/default-behavior/on-context-created.ts` — head petting (forward + backward swipe on the head touch
  strip within 1.5 s → HAPPY + heart for 5 s), button handlers, etc. stop working. Confirmed: petting did nothing with the
  MCP MOD installed. A custom MOD should call/replicate the default behavior.
- `set_emotion` works, but on the default `simple` face only the **eyes** change (`modules/ui/components/face/parts/eye.ts`;
  HAPPY = squint). The mouth ignores emotion — no visible smile. Other face styles: `ui.type` = `simple` (default), `dog`,
  `image`, `small-face` (`firmware/host/app/compose.ts`), untested.
- **Only two tools out of the box:** `set_emotion` (emotion enum from `face-state`) and `say_message` (`robot.audio.say`).
- Head motion, camera, touch, mic are host APIs (`firmware/host/modules/{camera,audio,…}`) — exposing them to Claude
  needs a custom MOD that registers more tools. Returning camera images over MCP is untested.
- MCP is request/response: Claude can make it speak/emote/look, but continuous listening is a separate voice path
  (firmware ChatService: OpenAI Realtime or XiaoZhi-v1-compatible server).

## Preferences (Wi-Fi, tokens, etc.)

Keys (`web/src/features/preferences/preference-model.ts`): `wifi.ssid`, `wifi.password`, `driver.type`
(`m5stackchan`), `driver.offsetPan`, `driver.offsetTilt`, `ui.type`, `ui.language` (default `ja`), `tts.type`, `tts.host`,
`tts.port`, `tts.token`, `tts.voice`, `tts.volume`, `ai.token`, `ai.context`, `mcp.token`, …

How they're set — BLE "setup mode":
1. **v1.1.0: after reset, a splash (`Stack-chan[・＿・]`) shows for 3 s with bottom buttons — tap the gear "Settings"
   button (label `設定` while `ui.language=ja`, "Settings" after switching to `en`; right-hand button if a "MODs" button is also shown).** Holding the screen
   during boot (what `firmware/docs/setting-preferences-web.md` says) did NOT work — docs are stale; see
   `firmware/host/app/default-behavior/startup-choice.ts` (`STARTUP_AUTO_BOOT_DELAY_MS = 3000`) and
   `firmware/host/modules/ui/views/splash/splash-view.ts`. Settings mode then advertises BLE name **`STK`**.
   (The MCP MOD's on-screen drawer button only shows/hides the endpoint URL; it doesn't set the token.)
2. Nordic UART service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`; write to RX `6e400002-…`, notifications on TX `6e400003-…`
   (each notification is `{"prop","value","readOnly"}` for current values).
3. Send `{"_batch":{"mcp.token":"<value>"}}` as UTF-8, **in 128-byte chunks** (firmware buffers until JSON parses).
Browser version: https://stack-chan.github.io/stack-chan/web/preference/ (Chrome, Web Bluetooth) → "STK".
Source: `firmware/host/modules/connectivity/preference-server.ts`, `web/src/services/preferences/ble-preference-client.ts`.

What actually worked (2026-09-16): start `stackchan_set_prefs.py` first (it scans up to 150 s), then press the bottom
reset button, tap the gear on the splash, leave the Settings screen open. Script connected, sent the batch, robot echoed
the new value. Then **press reset again without touching** → normal boot → `/mcp` accepted the token ~20 s later.
Prefs are only picked up by the MOD on the next normal boot.
Failed attempts: USB reset + "hold finger on screen" (stale docs) and USB reset + tap (user couldn't hit the 3 s window
after reading chat) — robot booted straight past the splash, no `STK` advertised.

Script (`~/stackchan-workspace/stackchan_set_prefs.py`): `uv run --with bleak stackchan_set_prefs.py` (sets `mcp.token` from Keychain) or
`… stackchan_set_prefs.py key=value …` for any keys. Values may be `@env:NAME` (read from `.env` next to the script, else the
environment) or `@keychain:SERVICE`; secrets (`mcp.token`, `ai.token`, `tts.token`, `wifi.password`) print as `<N chars>`.
Scans up to 150 s. Start it **before** pressing reset. First run: macOS asks to allow Bluetooth for the terminal app.
All values go over BLE as strings; the firmware coerces numbers (`tts.speed=1`, `tts.volume=0.5` worked).

The MCP token lives in **macOS Keychain**, service `stackchan-mcp-token`, account `stackchan` (64 hex chars, created
2026-09-16): `security find-generic-password -s stackchan-mcp-token -a stackchan -w`.

## Done / remaining

- ✅ `mcp.token` set over BLE (robot confirmed; after a normal reboot `/mcp` accepted it within ~20 s).
- ✅ Registered: `claude mcp add --scope user --transport http stackchan http://<robot-ip>:8080/mcp --header "Authorization: Bearer $(security find-generic-password -s stackchan-mcp-token -a stackchan -w)"`
- ✅ `tools/list` → `set_emotion` (`NEUTRAL, ANGRY, SAD, HAPPY, SLEEPY, DOUBTFUL, COLD, HOT`), `say_message` (`message`). Both calls returned success.
- Raw test: `curl -X POST http://<robot-ip>:8080/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "Authorization: Bearer $T" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
- After setting prefs in settings mode, **reboot with the bottom (reset) button without touching the screen** so the MOD reloads.

- ✅ **English speech via OpenAI TTS** (2026-09-16) — see "Voice / TTS" below.

Remaining:
1. ~~Speech~~ done.
2. ✅ Reserved `<robot-ip>` for MAC `<robot-mac>` on the router (2026-09-16).
3. ✅ `ui.language=en` set 2026-09-16 (valid: `ja` default, `en`, `zh` → `zh-CN`; `firmware/host/modules/ui/localization.ts`). Splash gear button now reads "Settings".
4. Custom MOD adding head / camera / touch tools (needs Moddable SDK or the web project editor to build an `.xsa`).

## Voice / TTS

Engine is chosen at boot from `tts.type` (`firmware/host/app/compose.ts`, map `ttsEngines`): `local`, `remote`, `voicevox`,
`voicevox-web`, `elevenlabs`, `openai`, `stackchan-voice`. The whole `tts.*` preference object is passed to the engine.
Allowed `tts.*` keys (`firmware/host/modules/preferences/consts.ts`): `type`, `host`, `port`, `token`, `volume`, `voice`, `speed`.

**Platform defaults (`firmware/host/platforms/m5stackchan_cores3/manifest.json`)** are for `stackchan-voice`:
`type: stackchan-voice`, `voice: "normal"`, `speed: 100`, `volume: 0.1`. `stackchan-voice` is a Japanese synthesizer
(English came out unintelligible).

**OpenAI engine** (`firmware/host/modules/audio/tts-openai.ts`, Moddable `openaistreamer`): sends
`{input, model: "tts-1", voice, speed, instructions: "", response_format: "wav"}`, plays 16-bit 24 kHz mono.
`model` and `instructions` are **not** preferences (hard-coded defaults). `voice ?? 'alloy'` / `speed ?? 1` only apply when
unset — the platform defaults are *set*, so they leak through:
- `voice: "normal"` → OpenAI **400** (voice must be one of `alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer`).
- `speed: 100` → OpenAI **400** (`speed` must be ≤ 4; range 0.25–4).
- On any HTTP error the firmware logs `ERROR: http request failed, status 400` and **software-resets**
  (`rst:0xc (RTC_SW_CPU_RST)`) → user sees face, then blank screen, no sound; the MCP call never returns (client times out).

**Working config:** `tts.type=openai tts.token=@env:OPENAI_API_KEY tts.voice=alloy tts.speed=1 tts.volume=0.5`
(volume range 0–1, `firmware/host/modules/preferences/volume-model.ts`). Set in Settings mode, then reboot without touching.

**Latency:** `say_message` returns only after playback ends — ~32 s for a two-sentence message (OpenAI generation + streaming
+ playback). Keep messages short; expect MCP clients to wait.

**OpenAI key:** created as **service account** in a dedicated project, restricted to audio/speech, small monthly budget
(the robot stores it in plaintext NVS — anyone with USB access can dump it). Validate a key without the robot:
```bash
K=$(grep -E '^OPENAI_API_KEY=' ~/stackchan-workspace/.env | cut -d= -f2-)
curl -s -o /tmp/t.wav -w '%{http_code}\n' https://api.openai.com/v1/audio/speech -H "Authorization: Bearer $K" \
  -H 'Content-Type: application/json' -d '{"model":"tts-1","voice":"alloy","input":"Hi.","response_format":"wav","speed":1,"instructions":""}'
```
(`GET /v1/models` may be refused for a restricted key; a one-word speech request costs a fraction of a cent.)
Replaying the firmware's exact JSON with the robot's settings against the API is how the 400s were diagnosed.

### Debugging speech

- `say_message` hanging/timeouts or a blank screen = the robot rebooted. Look at the serial log.
- **Opening the serial port with default pyserial settings resets the chip** (CoreS3 native USB: DTR/RTS → EN/IO0) and
  also kills whatever request was in flight. Set `dtr=False; rts=False` **before** `open()`.
- A reboot re-enumerates USB (`OSError: [Errno 6] Device not configured`) — use a logger that writes incrementally and
  reopens the port, e.g.:
```python
import serial, time, sys
out = open(sys.argv[1], 'ab', buffering=0); end = time.time() + float(sys.argv[2])
while time.time() < end:
    try:
        s = serial.Serial(); s.port = '/dev/cu.usbmodem2101'; s.baudrate = 115200; s.timeout = 0.3
        s.dtr = False; s.rts = False; s.open()
        while time.time() < end:
            d = s.read(4096)
            if d: out.write(d)
    except Exception as e:
        out.write(f"\n=== serial lost: {e}\n".encode()); time.sleep(0.5)
```
Run it in the background (`uv run --with pyserial python ~/stackchan-workspace/serlog.py /tmp/log 150 &`), then call the tool.

## Gotchas / lessons learned

- **Check what the stock firmware already exposes before flashing.** The stack-chan-skill assumed a custom ESP-IDF
  firmware; the factory firmware had BLE control (DANCE) and the community firmware had an MCP server MOD.
- **ChatGPT's summary was mostly right but overstated MCP**: "Claude can see/hear/move via MCP" — out of the box the
  MCP MOD only has `set_emotion` and `say_message`. Verify claims against source.
- The XiaoZhi "MCP endpoint" in the M5Stack app is for the robot's cloud AI to call *your* tools — wrong direction.
- Web installer ≈ three `esptool write-flash` calls; MOD install ≈ one write to the `xs` partition. No browser needed.
- **Back up the full 16 MB flash before flashing** (`read-flash` + `verify-flash`), ~2 min total.
- No full erase → factory NVS Wi-Fi credentials survived and the new firmware reused them.
- Use MOD `.xsa` files from the **release tag** matching the host, not `main`.
- Official `setting-preferences-web.md` (hold screen at boot) is **stale for v1.1.0** — it's a 3 s splash button now.
- BLE prefs: 128-byte chunked writes; TX notifications echo `{prop,value}` — good confirmation signal.
- macOS asks to grant Bluetooth to the terminal app on first `bleak` use; scanning returns nothing useful without it.
- Default voice `stackchan-voice` makes English unintelligible.
- **Switching `tts.type` is not enough** — the platform's `voice`/`speed` defaults are engine-specific and break OpenAI
  (400 → firmware reboot). Always set `tts.voice` and `tts.speed` (and check `tts.volume`) with the engine.
- Firmware errors in TTS reboot the robot instead of returning an MCP error — a hanging tool call means "check serial".
- My own serial logger reset the robot once and ruined a test — never open the port with default DTR/RTS.
- Secrets: MCP token in Keychain; OpenAI key in `.env` (user's preference over Keychain). Neither pasted into chat.
- Never paste tokens into chat/notes (the XiaoZhi JWT was pasted once — reset it if the factory firmware is restored).
- Source clones used during research were in a session scratchpad and are gone; re-clone with
  `git clone --depth 1 --filter=blob:none --sparse https://github.com/stack-chan/stack-chan` + `git sparse-checkout set <paths>`,
  or read single files with `gh api 'repos/stack-chan/stack-chan/contents/<path>?ref=v1.1.0' -q .content | base64 -d`.

## Timeline (2026-09-16)

1. Considered stack-chan-skill (ESP-IDF, custom `REMOTE.AGENT`) → nothing installed, robot not found on LAN port 6001.
2. Researched no-flash paths: DANCE BLE (verified UUIDs/JSON in factory source), XiaoZhi MCP endpoint (wrong direction).
3. Chose `stack-chan/stack-chan` v1.1.0. Verified release (targets, MCP Server MOD, M5Burner restore).
4. Backed up factory flash (verified), flashed v1.1.0 via esptool, confirmed boot + Wi-Fi.
5. Installed MCP Server MOD (`mcp.xsa` from v1.1.0 tag) → server up on :8080, 401 without token.
6. Generated token (Keychain), set via BLE Settings mode (after two failed timing attempts), rebooted.
7. Registered in Claude Code (`stackchan`, ✔ Connected); `set_emotion` HAPPY and `say_message` succeeded; speech garbled.
8. Chose OpenAI TTS. User created a service-account key → `.env`; validated with a one-word speech request.
9. Set `tts.type=openai` + `tts.token` over BLE → say_message hung, face then blank screen, no sound.
10. Serial log (non-resetting) showed `http request failed, status 400` + software reset. Replayed the request: the
    platform defaults `voice: normal`, `speed: 100` are both rejected by OpenAI.
11. Set `tts.voice=alloy tts.speed=1 tts.volume=0.5` → English speech works (~32 s round trip). ✅

## Security notes

- The MCP endpoint is plain HTTP on the LAN; the Bearer token is the only protection. Use a long random token.
- Factory backup contains Wi-Fi credentials and XiaoZhi tokens.
- `~/stackchan-workspace/.env` holds the OpenAI key (chmod 600). The same key sits in plaintext on the robot's flash —
  service-account key, restricted, dedicated project with a budget; revoke it in the OpenAI dashboard if the robot is lost.
- `say_message` + future tools = anyone with the token can make the robot speak/move/see.

## Sources

- https://github.com/stack-chan/stack-chan (releases, `firmware/README.md`, `firmware/docs/setting-preferences-web.md`, `web/`)
- https://github.com/m5stack/StackChan (factory firmware source)
- https://github.com/yossitv/kawaii-home-studio (BLE control of factory firmware)
- https://github.com/78/mcp-calculator (XiaoZhi MCP endpoint client)
- https://docs.m5stack.com/en/StackChan (M5Burner restore)
- https://stack-chan.github.io/stack-chan/web/ (web tools: flash, preference, MOD Gallery, editor, simulator)
- https://github.com/stack-chan/stack-chan/releases/tag/v1.1.0 (release notes, firmware zip + `.sha256`)

## Custom MOD plan (research 2026-09-16, source-read only — nothing built or tested yet)

Status: **being built** in `~/code/yaniv/oss/stackchan-mcp-mod` (local git, public-repo location, no remote yet).
Phases 1-3 + 5 are **installed and verified on the device 2026-09-16**: default behaviors kept, emotion, speech, head
motion, LEDs, face, input events, camera photo — 18 tools. See "Custom MOD — toolchain and results" and "Custom MOD —
device limits and dead ends" below. Remaining: mic (phase 4), smile face (phase 6), screen touch via a UI overlay,
then I2C sensors / IR / NFC ("Phases 7-10").

Goal: one MOD that keeps default behaviors (petting etc.) and adds MCP tools: head motion, camera photo, touch events,
LEDs, a real smile — plus the existing `set_emotion` / `say_message`.

**Robot API for MODs** (`firmware/host/app/capabilities.ts`, `firmware/docs/api.md`, v1.1.0):
- Head: `robot.motion.setTorque(true)`, `robot.motion.setPose({position:{x,y,z}, rotation:{r,y,p}}, seconds)`, `lookAt([x,y,z] m)`,
  `lookAway()`, `robot.motion.pose.body.rotation`. **Radians.** Yaw + = left, clamped ±128°. Pitch servo = `-p`, clamped
  0..90° → usable `p` is `-π/2` (up) .. `0` (level); positive `p` clamps to level (`modules/motion/m5stackchan-servo.ts`).
- Camera: `robot.camera.capture({width,height,imageType})` → `{width,height,imageType,buffer,close()}`, `start/stop`. CoreS3
  sensor GC0308 = **no JPEG**; use `rgb565le` (default 176×144; preview uses 160×120) and encode PNG in the MOD.
  `Uint8Array.prototype.toBase64()` exists. Capture pauses head touch panel (`app/runtime-camera.ts`). Always `close()` + `stop()`.
- Touch: head strip `robot.input.touchPanel.subscribe(ev)` → `{gesture:'press'|'release'|'forwardSwipe'|'backwardSwipe', position,
  intensity, ticks}`; screen `robot.input.touch?.onEvent` → `{phase, id, x, y, ticks}`; also `robot.input.imu`, buttons.
- Mic: `robot.audio.record(ms)` → WAV ArrayBuffer (16 kHz, 16-bit, stereo, ~190 KB/s).
- LEDs: `robot.lighting.lightOn('head', r,g,b, duration?, index?, count?)`, `lightOff`, `lightBlink`, `lightRainbow` (12 LEDs).
- Face/speech: `robot.face.setEmotion/setColor/setMouthOpen/setEyeOpen`, `robot.audio.say(text)`, `robot.ui.setFace(face)`.

**Keep default behaviors:** `import { onContextCreated as base } from 'app-default-behavior/on-context-created'` (exported by
host `app/manifest.json`) and call `base(robot)` first (unverified on device). Fallback: copy petting block
(`default-behavior/on-context-created.ts` ~622-706).

**Images over MCP:** stock `MCPServerService` wraps every result as text (private methods). Vendor a copy as
`mcp-server-rich.js` in the MOD and pass through `{content:[…]}` results → `{type:'image', data:<base64>, mimeType:'image/png'}`.
160×120 RGB PNG ≈ 58 KB (≈77 KB base64); grayscale ≈ 19 KB PNG (≈26 KB body). Memory fit unverified.

**Real smile:** simple face mouth (`parts/mouth.ts`) ignores emotion. Option A: custom face in MOD (copy `SimpleFace` template
from `behaviors/face.ts`, keep `Eye`, new mouth shape whose `onFaceState` draws a smile curve for `Emotion.HAPPY`),
`robot.ui.setFace(...)` after `base(robot)`. Option B: image avatar pack with a smiling HAPPY mouth (`mods/examples/image_avatar_lite`).
Drawer "face" selection overrides a custom face.

**Build:** Moddable SDK **9.0.0** (XS 17.8.0 — must match host `9.0.0+stackchan.1`; device checks XS major.minor, repo's
`npm run mod` requires `$MODDABLE/tools/VERSION` = 9.0.0). **No ESP-IDF needed** for `mcrun`. Setup: shallow clone
Moddable tag `9.0.0` + release `moddable-tools-mac64arm.zip` (or `make` in `build/makefiles/mac`). From stack-chan `firmware/`:
`mcrun -d -m -p esp32:./host/platforms/m5stackchan_cores3 -t build <manifest>` (= `npm run mod:build -- <manifest>`);
`npm run mod -- <manifest> --port /dev/cu.usbmodem2101` flashes to `xs` (256 KB partition). MOD manifest:
`{"include":["$(MODDABLE)/examples/manifest_mod.json"],"modules":{"*":["./mod","./mcp-server-rich"]}}`.
Browser editor: Blockly-only source and hosted site targets SDK 9.5 / `develop` → rejects the 9.0.0 host. Not usable.
Alternative install: `.xsa` in `/sdcard/mods/` via on-device MOD manager (gesture unconfirmed).
Examples: `mods/examples/look_around` (lookAt), `m5stackchan_smoke` (setTorque/setPose/LEDs), `image_avatar_lite` (face).

**Crash rules (ESP32):** any uncaught exception or unhandled promise rejection → `fxAbort` → reboot (same as the TTS 400).
try/catch in every handler, Timer and subscribe callback; `.catch` every promise. Errors inside `onContextCreated` are caught
by `main.ts` (MOD just stops). Tool errors surface as a generic JSON-RPC "Parse error".
Rollback anytime: re-flash the stock `mcp.xsa` (v1.1.0 tag) to `0xfa0000`.

## Full sensor hardware (M5Stack docs, docs.m5stack.com/en/StackChan — not yet verified on device)

| Sense | Chip | Bus / address / pin | Firmware support (stack-chan v1.1.0) |
|---|---|---|---|
| Camera | GC0308 0.3 MP | integrated | `robot.camera` (rgb565le, no JPEG) |
| Microphones | ES7210 codec | I2S | `robot.audio.record` |
| Head touch (3-zone) | Si12T | I2C 0x68 | `robot.input.touchPanel` |
| Screen touch | CoreS3 touch | I2C | `robot.input.touch` |
| IMU accel+gyro | BMI270 | I2C | `robot.input.imu` |
| Magnetometer | BMM150 | I2C | host imports BMI270 as "Accelerometer-Gyroscope-Magnetometer"; unverified |
| Proximity + ambient light | LTR-553ALS-WA | I2C | none — needs JS driver |
| Battery monitor | INA226AIDGSR | I2C 0x41 | none (host has AXP2101 battery-status module for the status bar) |
| Power mgmt | AXP2101 | I2C | `modules/power/axp2101-battery-status` |
| RTC | BM8563 | I2C | host RTC |
| IO expander | PY32L020 | I2C 0x6F (0x71 alt): IO1, IO14, VM_EN (servo power), RGB (12 LEDs); has GPIO/ADC/PWM | used by host for servo power + LEDs |
| **NFC** | **ST25R3916-AQWT** | I2C **0x50** | none in either firmware — complex RF front end (ST RFAL C library) |
| **IR receive** | IRM56384 | **G10** (IR_REC) | none |
| **IR send** | IR LED | **G5** (IR_SEND) | none |
| Servos (feedback) | serial bus servos | G6 TX / G7 RX | position via `mods/examples/calibration` readAngle |
| Wi-Fi / BLE | ESP32-S3 | — | Wi-Fi scan/RSSI in settings; BLE local peer |

Pins: I2C internal SCL G11 / SDA G12. Grove ports: A G2/G1, B G9/G8, C G17/G18.
Schematics: `https://m5stack-doc.oss-cn-shenzhen.aliyuncs.com/490/Sch_M5_CoreS3_v1.0.pdf`,
`https://m5stack-doc.oss-cn-shenzhen.aliyuncs.com/1205/SCH_{Adapter,Power,Ring,Touch}.pdf`.

⚠ **Unresolved pin conflict:** stack-chan host provider sets `pin.displaySelect: 5` and an Analog on pin 10, but docs say
IR_SEND = G5, IR_REC = G10. Confirm from schematics before driving G5/G10.

Feasibility tiers: (1) I2C sensors (LTR-553, INA226, BMM150), servo angles, RTC, RSSI → JS in a MOD; (2) IR receive →
`device.io.PulseWidth` in a MOD, after pin check; (3) IR send → 38 kHz carrier timing likely needs RMT/native → maybe
host rebuild; (4) NFC → minimal JS ISO14443A UID driver (hard) or native driver + host firmware rebuild (ask user first).
Handed to session `new-stackchan` as phases 7–10 (2026-09-16).

## Custom MOD — toolchain and results (verified 2026-09-16)

Repo `~/code/yaniv/oss/stackchan-mcp-mod` (Apache-2.0; `mod/mcp-server-rich.js` is derived from the host's
`mcp-server.ts`). `scripts/build.sh`, `scripts/install.sh`, `scripts/mcp.sh` wrap everything below.

**Toolchain (works, no ESP-IDF needed):**
```bash
git clone --depth 1 --branch 9.0.0 https://github.com/Moddable-OpenSource/moddable ~/code/3rd-party/moddable
gh release download 9.0.0 -R Moddable-OpenSource/moddable -p moddable-tools-mac64arm.zip
unzip -d tools moddable-tools-mac64arm.zip && cp -R tools/. ~/code/3rd-party/moddable/build/bin/mac/release/
# the release tools are NOT quarantined when fetched with gh; `xattr -d com.apple.quarantine <file>` if downloaded via a browser
git clone --depth 1 --branch v1.1.0 https://github.com/stack-chan/stack-chan   # platform config for mcrun
export MODDABLE=~/code/3rd-party/moddable PATH=$MODDABLE/build/bin/mac/release:$PATH
cd stack-chan/firmware && mcrun -m -p esp32:./host/platforms/m5stackchan_cores3 -t build -o <out> <mod>/manifest.json
```
- `~/code/3rd-party/moddable/tools/VERSION` = `9.0.0`; the git tag `9.0.0` is a non-commit ref (git warns, checkout works).
- `-o <dir>` must **already exist** (`mcrun` errors with "directory not found").
- Output: `<out>/bin/esp32/release/mod/mod.xsa`. Release mode (no `-d`) matches the gallery build: rebuilding the stock
  `web/mod-gallery/samples/mcp/mod` gave a byte-identical size (4623) and `VERS 17.8.0`, differing only in 20 bytes
  (the `SIGN` hash + 4 bytes at 0x3723).
- Install: `esptool --chip esp32s3 --port /dev/cu.usbmodem2101 --baud 921600 --after no-reset write-flash 0xfa0000 mod.xsa`
  (esptool verifies the hash itself). `--after no-reset` leaves the chip idle so a serial logger can catch the next boot.
- Rollback: stock MOD saved at `~/stackchan-workspace/mods/stock-mcp-v1.1.0.xsa`
  (sha256 `ff2554730413a7fa6671945c29a3505fe54826d6b060242f30b8827260d3ad42`, from the v1.1.0 gallery).

**Keeping the default behaviors works.** `import { onContextCreated as onDefaultContextCreated } from
'app-default-behavior/on-context-created'` and call it first inside the MOD's own `onContextCreated`
(wrapped in try/catch so the MCP server still starts if it throws). Boot log shows
`[mcp-mod] default behaviors installed`, and **head petting was confirmed working on the device** with the MOD installed.

**Phase 1 device results (2026-09-16):** `initialize` (protocol `2024-11-05`), `tools/list`, `ping`,
`notifications/initialized` (HTTP 202, no body), `tools/call` for `set_emotion` / `say_message`, an invalid emotion
(`isError` result, robot unaffected), and an unknown tool (JSON-RPC `-32602`) all behave. `GET /health` unauthenticated.

**Serial gotcha corrected:** opening `/dev/cu.usbmodem2101` with `dtr=False; rts=False` set **before** `open()`
still reset the robot on this Mac (`rst:0x15 (USB_UART_CHIP_RESET)` in the log; a firmware crash instead shows
`rst:0xc (RTC_SW_CPU_RST)`). Treat any serial open as a reboot: only log right after flashing, not while testing.
A blank screen with `/health` still answering is the known display-blank state, not a crash — tap the screen.

## Phases 7-10 (I2C sensors, IR, NFC) — not started

Scope added by the user 2026-09-16: cover NFC + IR + remaining sensors after the six MOD phases. Hardware per
docs.m5stack.com/en/StackChan: IR_SEND G5, IR_REC G10 (IRM56384); I2C (SCL G11 / SDA G12) devices NFC ST25R3916 @0x50,
Si12T head touch @0x68, INA226 battery @0x41, PY32L020 IO expander @0x6F, AXP2101, BM8563 RTC, BMI270 IMU, BMM150
magnetometer, LTR-553ALS proximity/ambient light. Ports A=G2/G1, B=G9/G8, C=G17/G18.
**Unresolved conflict to settle before driving G5/G10:** the v1.1.0 provider
(`host/platforms/m5stackchan_cores3/host/provider.js`) declares `pin.displaySelect: 5` and an `Analog` on pin 10 —
the same pins the docs call IR. Confirm against the schematics before touching either pin.

## Custom MOD — device limits and dead ends (measured 2026-09-16)

**Response payload is the binding constraint.** Measured against `POST /mcp` on the device:

| Body size | Result |
|---|---|
| ~26-28 KB (160x120 grayscale and 256-color PNG) | served fine, repeatably |
| ~56 KB (240x176 grayscale) | never completes; **the HTTP accept loop dies** — robot still pings, `/health` stops answering |
| ~77 KB (160x120 truecolor) | client received ~1.4 KB (one TCP segment) then stalled; same server death |

**The true threshold is somewhere between ~28 KB and ~56 KB and has never been measured.** What is established is
that bodies up to ~27.8 KB work repeatably and ~56 KB reliably kills the server; treating any single figure as the
hard limit overstates the evidence.

Consequences baked into the MOD: `take_photo` budgets the **response body** (base64 is 4 bytes per 3, plus the JSON
envelope) against 28 KB, rather than capping raw PNG bytes — capping the bytes let a 20 KB image become a 27 KB
body; base64 is written
directly into the response ArrayBuffer (no intermediate JS string + JSON string, which had ~4 copies of the payload
alive at once); the server **restarts its listener** (5 attempts, 2 s apart) if the accept loop ever ends.
A too-large reply also **blanked the display** — first sign of memory pressure.

**Camera works from a MOD.** `robot.camera.start/capture` with `imageType` chosen from `config.format`, which is
`RGB565BE` on this platform (not LE — the host's own preview picks the same way). Frame is 38,400 bytes for 160x120,
`frame.buffer` is a disposable ArrayBuffer: `close()` it, then `stop()` the camera (a 120 ms delay before stop, like
the host preview). Capture pauses the head touch strip and resumes it automatically.
No JPEG on the GC0308 and **no deflate module in the host**, so PNG is encoded in JS with *stored* (uncompressed)
deflate blocks: 160x120 gray = 19,388 B, **3-3-2 palette color = 20,168 B** (color type 3 + 768-byte PLTE — same
ballpark as gray, a third of truecolor's 57,788 B). Both verified byte-exact against Python zlib on the desktop.

**Head motion: `setPose` resolves when the move STARTS**, not when it finishes (the host's own servo test does
`await setPose(...)` then `await wait(1000)`). Releasing torque right after it resolves leaves the head limp and
**nothing moves**. Keep torque on for `duration + ~150 ms`. Confirmed on the device: with the wait, the head moves.

**Screen touch DOES work through a custom face** (solved 2026-09-16, v0.12.0). The face component's Piu behavior
gets the touch and does `container.bubble('onFaceTouch')` (`ui/components/face/behaviors/face.ts:144-146`), which is
how the app bar/drawer is revealed. A MOD can install its own face via `robot.ui.setFace()` whose behavior subclasses
the host `FaceBehavior`, calls `super.onTouchEnded(container)` (preserving the bubble, so the drawer still opens) and
also reports the touch to the MOD. Verified on the device: tapping the screen produces
`kind=touch phase=began/moved/ended x=180 y=145` in screen pixels, and the drawer still appears. Piu repeats
`onTouchMoved` while a finger rests still (7 duplicates for one tap), so drop unchanged positions.

**A real smile is possible** (v0.12.0): subclass the host `FaceBehavior`, reuse the real `Eye` part, and replace only
the mouth with a `Port` whose `onDraw` branches on `face.emotion === Emotion.HAPPY` (state arrives via
`container.distribute('onFaceState', …)`, `face.ts:216`). Verified on the device — HAPPY now draws a curved smile
instead of the stock rectangle. The drawer's face selector (simple/dog/image) overrides it.

**Screen touch cannot be opened directly by a MOD.** `robot.input.touch` is `undefined` on this platform (the host only builds
it when `config.Touch` is set). Opening it directly from the MOD
(`new Touch(config.Touch ?? device.sensor.Touch, …)`) fails with **`duplicate address`** — Moddable's Piu setup
(`$MODDABLE/build/devices/esp/setup/piu.js`, `new config.Touch`) already holds the FT6206 for the UI, and the I2C
layer refuses a second client at the same address. It fails cleanly (no crash, no contention). Remaining option is a
Piu overlay content that captures touches through the UI layer.

**Virtual A/B/C buttons exist in the CoreS3 target but are disabled.**
`$MODDABLE/build/devices/esp32/targets/m5stack_cores3/M5StackCoreS3Touch.js` maps a touch at `y >= 200` onto
`globalThis.button[a|b|c]` (three ~107 px columns) — but only if those objects exist, and
`config.virtualButton` is **false** in both the Moddable target and stack-chan's platform manifest, so
`globalThis.button` has no a/b/c. Creating them from a MOD is pointless without owning the touch instance that calls
`sample()`. Real buttons on this hardware: **`power` only** (`enablePowerButton: true` in the host app manifest).

**Input event sources that do work from a MOD:** head touch strip (`touchPanel.subscribe`, multi-listener, gestures
`press/release/forwardSwipe/backwardSwipe` + `tap`), IMU recognized motions
(`shake/fallenForward/fallenBackward/fallenLeft/fallenRight/upsideDown`), and the power button. IMU, touch and buttons
expose a **single `onEvent` slot that the default behavior already fills** — chain it, don't overwrite it, or petting
and the IMU emotion reactions die.

**Blank screen: what it actually is.** Recurred several times, always after heavy memory use (a color capture
before the size cap, a 64 KB microphone recording, an oversized response). While blank, the robot keeps serving MCP
(`/health` ok, tools work) — and once, with the screen working, tapping it opened the drawer normally, so the UI
itself is fine until memory pressure kills the display. **There is no software brightness control on CoreS3**:
`Host.Backlight.write()` (Moddable target `setup-target.js`) assigns `globalThis.power.brightness`, and that file's
`Power` class has no such property — the assignment does nothing. `power.resetLcd()` exists (AW9523 expander, reg
0x03 bit 5) but resets the panel without re-initializing it. Recovery is a **hardware** reset or a power-cycle — **not** a software restart, which is itself the trigger
(see "Software restart kills the display" below).

**Flashing gotcha:** after the app wedges (blank screen + dead HTTP server), `esptool` could not enter download mode
(`No serial data received`, port present). Fix: start `esptool` with `--connect-attempts 4+` and **press the bottom
reset button** while it retries. Nothing was half-written (the MOD still reported its old version afterwards).

## Custom MOD — tool list as of v0.16.0 (28 tools, all verified on the device 2026-09-16)

`set_emotion`, `say_message` · `set_head_pose`, `look_at`, `look_away`, `get_head_pose`, `set_torque` ·
`set_leds`, `blink_leds`, `rainbow_leds`, `leds_off` · `set_face_color`, `set_mouth_open`, `set_eye_open` ·
`get_recent_events`, `wait_for_event`, `get_input_capabilities` · `take_photo` ·
`listen`, `record_and_play`, `get_recorded_audio`, `play_tone`, `sing` · `get_robot_info`, `restart_robot`,
`get_power_registers` · `show_message`, `hide_message`.
Plus the custom smile face and screen-touch capture (not tools, but part of the MOD).

Notes on the audio ones: the mic reports **16 kHz / mono / 16-bit** on this device (~32 KB/s), despite
`host/modules/audio/manifest.json` declaring `numChannels: 2` for this platform — the WAV header is authoritative and
the MOD parses it. `listen` returns loudness only (RMS/peak/dBFS + per-200 ms slices), never audio.
`get_recorded_audio` box-filters down to mono at 1/N sample rate until the WAV fits under 20 KB and returns it as an
MCP `resource`. `sing` needs `tts.type=stackchan-voice`; with OpenAI TTS it returns "The active TTS does not support
singing" as a clean tool error. `play_tone` takes Hz, ms and volume 0..1.

## ⚠ Software restart kills the display (2026-09-16, root cause found)

**`globalThis.System.restart()` leaves this robot's screen permanently dead** until someone physically power-cycles
it (hold power until off, then press again). Isolated by changing one variable at a time with the user watching the
screen:

| Action | Display |
|---|---|
| AXP2101 register reads (I2C) | fine |
| `take_photo` (camera) | fine |
| `listen` + `record_and_play` (64 KB buffer, speaker) | fine |
| **soft restart (`System.restart()`)** | **dead** |
| **bottom reset button** | **fine** |
| **200 ms RTS/EN pulse over USB (pyserial)** | **fine — also revives a blank screen** |
| **esptool's own reset after flashing (`--after hard-reset`)** | **usually dead** |

So it is not memory pressure, not the camera, not audio, not the PMIC: **every power register read while broken was
byte-identical to the healthy baseline** (rails `0x90 = 0xbf`, same voltages, same status bits). The CPU reboots
normally, the boot log is identical, and everything except the LCD works. A warm boot simply never re-initializes
the panel; only a PMIC power-off/on does.

**This affects the stock firmware too:** the host's own `mod-manager.ts` calls `System.restart()` after installing a
MOD, so installing a MOD through the on-device MOD manager should blank the screen the same way. Worth reporting
upstream to stack-chan.

**Display init after a warm reset is unreliable — treat it as probabilistic.** A pulse that works twice can fail on
the next flash, and further pulses can then bring it back, so no reset recipe is dependable. What holds up:
- A **software restart never** restores the display (see the table above).
- **Pulsing EN** from pyserial works *more often* than esptool's own post-flash reset, and a second pulse sometimes
  succeeds where the first failed — worth trying before anything else, and it can revive an already-black screen.
- On this unit the **bottom reset button is strictly better than pulsing EN from the host**. Measured
  2026-09-17 across four consecutive flashes: **every** flash left the panel blank, one or two EN
  pulses recovered it sometimes, and the button recovered it every time. Plan on pressing it after
  every install rather than hoping. Treat `scripts/reset.sh` as the
  remote option for when nobody is near the robot, not the first thing to try when someone is.
- A **power-button off/on always works**. When in doubt, do that.

Practical rules:
- Flash with `--after no-reset`, then pulse RTS twice. `scripts/install.sh` in the MOD repo does this.
- **Never** reboot this robot in software unless a blank screen is acceptable.
- If the screen is black: try an EN pulse or two first; if it stays black, power-cycle by hand (hold power until
  off, then press again). Do not assume a flash left the display working — look at it.
- The MOD's `restart_robot` requires `accept_display_blank: true` and says so in its description: it causes a blank
  screen rather than recovering one.

## ⚠ The display can stop rendering with no reset at all (2026-09-17)

**Symptom: the panel is backlit and completely empty.** No face, no startup splash residue, no speech balloon —
but the screen is visibly lit. This is a *different* failure from the PMIC one above, where the backlight is off
too and nothing shows even under a torch. Check the backlight first; it decides which of the two you have.

Everything except drawing is healthy. What was checked while it was broken, with the user watching the screen:

| Check | Result |
|---|---|
| Did it reboot? | **No.** `get_robot_info` uptime ran continuously across the episode — 3489 s, then 3943 s eight minutes later |
| PMIC rails | Every AXP2101 register byte-identical to the healthy baseline (`0x90 = 0xbf`, same voltages, same status bits) |
| Is the app alive? | MCP answers every call, the head touch strip records new events (sequence numbers advanced with the user's taps), the head-ring LEDs light on command |
| Draw something over it | `show_message` returned success; no balloon appeared |
| A face colour collision — white face on a white background | **Excluded.** Setting `secondary` to black, `primary` to red and the emotion to HAPPY changed nothing on screen |
| Recovery | The **bottom reset button** restored it, and the face came back working |
| Reproduction attempt | The same capture tier, run once on a freshly reset robot: **display unaffected**. So that sequence alone is not sufficient |

**The cause is unestablished, and it recurs.** The best candidate is **phantom petting**: with the USB cable
plugged directly into a laptop sitting beside it, this robot's head touch strip fires continuously on its own
(see "The head touch strip fires on its own next to a laptop", below), and every phantom stroke makes the
firmware run its petting reaction — which swaps the face, moves the head and interrupts speech. That is the host
repeatedly replacing the displayed face out from under a MOD's own, which is a far better explanation for a panel
that stops painting than anything a MOD does deliberately.

The capture tier was the earlier suspect, because a run of `camera_take_photo`, `mic_listen`, `mic_get_audio` and
`mic_record_and_play` preceded the first episode and each draws and removes an on-screen prompt. That is now
unlikely: the same tier on a freshly reset robot did not reproduce it, and 30 balloon show/hide cycles and 32
emotion changes in isolation did not either. Both of those tests ran while phantom touches were streaming in,
which is the variable nobody controlled for at the time.

### The head touch strip fires on its own next to a laptop

**Measured 2026-09-17.** With the USB cable plugged directly into a MacBook standing next to the robot, the head
touch strip generated **64 events in 56 seconds** with nobody touching it — `press` and `release` alternating
between `position=100` and `position=-100`, the two ends of the strip, which is noise rather than a finger. The
same robot produced **zero events in 60 seconds** with the cable unplugged, and **zero in 30 seconds** with the
cable plugged back in but the robot moved away from the laptop. So the trigger is proximity and the shared ground,
not the cable itself: a laptop's chassis floats, and on a two-prong charger the supply's filter capacitor leaves it
at a fraction of mains voltage, which couples onto the robot's ground and the strip reads it as touch.

Why it matters beyond a stray event in the log: each phantom stroke runs the firmware's **petting reaction**, which
draws a heart, moves the head and interrupts whatever the robot was doing. Symptoms this produced before the cause
was found: speech stopping mid-sentence and resuming seconds later, a `say_message` call timing out at 60 s, a
"weird face with a heart" appearing unbidden, and the head moving with no motion command sent. If this robot
appears possessed, read the touch-panel events first.

### Attaching a serial logger resets the robot, repeatedly

`serlog.py` sets `dtr`/`rts` false before `open()`, which is meant to avoid the reset a plain
`serial.Serial(port)` causes. It is not enough on this target: each `open()` still resets the chip, and
the logger's reconnect loop reopens the port whenever the USB device drops - so a long capture produces
a series of resets rather than a log of one failure. Observed 2026-09-17: `=== serial opened 16:06:38`
in the capture, and the robot's uptime reset to 20 s in the same second.

The consequence for diagnosis is the important part:

- **A reset uptime does not imply an uncaught exception.** A hardware reset zeroes uptime and leaves no
  trace at all, so an abort and an electrical reset look identical from the network. Before blaming code
  for a reboot, account for anything that touched the serial port, and for the USB connection itself -
  the same capture showed the device disconnecting and reconnecting several times a minute.
- A capture is only trustworthy if nothing reopens the port during it. There is no known way to follow
  this device's log across a reboot from the host side.

### The lit-but-empty panel happens both with and without a reset

The failure where the panel stays backlit and paints nothing has now been seen in both circumstances:
with uptime running unbroken through it (2026-09-17 morning, above), and immediately after resets
(2026-09-17 afternoon). So "backlit and empty" does not by itself distinguish a failed warm-reset
display init from whatever the no-reset case is. The backlight tells you it is not the PMIC case; it
does not tell you which of the other two you have.

Practical rules:

- **A blank screen is not evidence of a crash.** Read the uptime first. Continuous uptime means the app never
  restarted, so there is no reboot to hunt for in MOD code — an uncaught exception would have reset the device and
  zeroed it.
- No tool can bring the panel back. A hardware reset (bottom button) or a power cycle is the only route.
- Do not run the self-test's capture tier without someone looking at the screen.

## Earlier display episode (2026-09-16) — same symptom, same cause

**Resolved:** a long power-button press (full power off) followed by a short press to power on brought the display
back. Note that with a blank screen you cannot tell whether the long press powered the device off, so the sequence
that worked was: long press, long press again, then a short press. Confirms the cause was **AXP2101/PMIC state**, not
a hardware failure and not the MOD.

Symptom while broken: **nothing on screen at all** — no face, no 3 s startup splash, and no faint unlit image under a torch.
Everything else is healthy: Wi-Fi, servos, head touch strip, IMU, camera captures, microphone, speaker, MCP
(`/health` + all 25 tools). Persists across a soft restart, a hardware reset pulse **and a full power cycle**.

Evidence it is not the MOD or the app: the boot log from when the face demonstrably worked (phase 1, petting turned
it HAPPY) is **line-for-line identical** to the current cold boot apart from the MOD's own trace lines — same
`[m5stackchan] patched CoreS3 AXP2101 power rails`, same servo/touch init, same `[main] app behaviors ready`.
The splash is drawn by the default `onLaunch` before any MOD code runs, and it is absent too. The firmware traces
nothing about display init, so there is no software error to find.

Ruled out / learned along the way:
- Not the earlier memory-pressure blanking (that recovered on reboot; this does not).
- No software brightness control exists on CoreS3 (see the blank-screen note above), so it cannot be "backlight off"
  set by software.
- The boot patch re-enables the LDO rails every boot (`0x90 = 0xbf`, `0x30 = 0b111111`), so a latched-off rail
  should not survive a reset, and a cold power cycle would clear the AXP2101 anyway.

**"Power cycling" this robot:** unplugging USB does **not** power-cycle it — the internal
battery keeps the AXP2101 alive, so its registers are never reset. Only a long press of the power button (~6 s, full
power off) or disconnecting the battery resets the PMIC. Every "power cycle" attempted on 2026-09-16 was really just a
CPU reset, so PMIC state was never cleared and is **not** ruled out.

Leading hypothesis: the AXP2101 has **latched a protection fault** (e.g. over-current) on the rail feeding the
display. That survives CPU resets and USB unplugging, and the boot patch only writes rail *enable* bits
(`0x90 = 0xbf`) — it never clears a fault or the IRQ status registers, which would explain identical boot logs with
no image. (An earlier guess that USB bus power plus the ±128° servo swing starved the board was dropped: the battery
was full and the hardware was never physically touched.)

Next diagnostics, cheapest first:
1. **Real power-off**: hold the power button ~6 s until it powers down, wait ~10 s, power on. This is the only way to
   reset the PMIC; a USB unplug does not.
2. **Read the PMIC**: MOD tool `get_power_registers` (v0.10.0) dumps AXP2101 rail-enable, voltage and IRQ/fault
   registers read-only via `import { getAxp2101Power } from 'axp2101-power-capture'` — the host module that hands
   back the live instance, avoiding the "duplicate address" refusal. Compare `0x90` against `0xbf` and check
   `0x48`/`0x49`/`0x4a` for fault bits.
3. If a rail reads disabled or a fault bit is set, clearing the fault / re-enabling that rail is the candidate fix —
   **writes to a PMIC can damage hardware, so decide deliberately**; `tools-power.js` exposes reads only.
4. `globalThis.power.resetLcd()` (AW9523 reg 0x03 bit 5) resets the panel but does not re-initialize it.
5. Restore the factory firmware from `factory-backup/` — if M5's own UI is also blank, it is hardware.

### Healthy AXP2101 baseline (read 2026-09-16 right after recovery, display working)

Read with the MOD's `get_power_registers` tool. Compare against this if the display dies again:

```
0x00 PMU status 1        0x28    0x30 ADC enable      0x3f    0x90 LDO enable mask 0xbf
0x01 PMU status 2        0x14    0x62 charge current  0x0d    0x92 ALDO1 voltage   0x0d
0x27 PWROFF/PWRON config 0x00    0x69 CHGLED ctrl     0x35    0x93 ALDO2 voltage   0x1c
0x48 IRQ status 1        0x10    0x80 DCDC enable     0x05    0x94 ALDO3 voltage   0x1c
0x49 IRQ status 2        0xa3                                 0x95 ALDO4 voltage   0x1c
0x4a IRQ status 3        0x30                                 0x96 BLDO1 voltage   0x17
                                                              0x97 BLDO2 voltage   0x1c
```

**Caveat:** the IRQ status registers already carry set bits in this perfectly healthy state — nothing clears them, so
they accumulate and are **not** by themselves proof of a fault. Diff the whole set against this baseline instead.

## Microphone is ~30 dB quiet (measured 2026-09-16)

A hard clap right next to the robot peaks at only **-30 dBFS**; normal speech sits near -42 dBFS RMS. Analysis of the
raw samples (range [-251, 865] out of +-32768, 7% zero-crossing rate, no common divisor) shows **clean audio at a
tiny amplitude** — not bit-misalignment or garbage, so the capture path works, it is just far too quiet.

**Where the gain lives, and why the obvious answer is wrong.** The CoreS3 mics feed an **ES7210 audio ADC at I2C
0x40**. Moddable's target setup (`build/devices/esp32/targets/m5stack_cores3/setup-target.js`, class `ES7210`)
writes `MIC1_GAIN` (0x43) and `MIC2_GAIN` (0x44) = `0x1B`: bit 4 is `SELMIC` (differential input select, not a gain
enable), and gain code 11.

Per the ES7210 datasheet rev 21.0, register 0x43 steps 3 dB per code to code 11 = **33 dB**, then 1.5 dB per code to
code 14 = **37.5 dB** — not 3 dB throughout. The unused analog range is therefore **4.5 dB**, so the PGA **cannot**
explain a ~30 dB deficit: at maximum it would move a -30 dBFS clap to -25.5 dBFS.

**The cause is not established.** The measurement is solid, the explanation is not. Leading candidate: the ES7210's
**ADC digital gain** registers 0x1B-0x1E (up to +32 dB in 0.5 dB steps, default 0 dB) are never written by that init
table, which touches only 0x00-0x0A, 0x11, 0x20-0x23 and 0x40-0x4C. Untested on the device.

The I2S side is compile-time too: `host/modules/audio/manifest.json` defines
`audioIn: { sampleRate: 16000, bitsPerSample: 16, numChannels: 2, i2s: { slot: I2S_STD_SLOT_BOTH, datain: 14, … } }`
for this platform, while the host's `Microphone` asks for 1 channel; the WAV header comes back **16 kHz mono 16-bit**.

**A MOD cannot change it.** Opening 0x40 fails with `duplicate address` — the firmware holds the ES7210 (it is
`globalThis.mic`, with a private I/O handle). Raising the gain therefore needs a **host firmware rebuild** — setting the
ADC digital gain, not the PGA, and possibly revisiting the I2S slot config.

**What the MOD does instead:** software gain (default **16x**) on `record_and_play` and `get_recorded_audio`, with
clipped-sample counts and `gain: 1` for the raw signal; and the loudness thresholds are offset by the measured 30 dB
(`CAPTURE_OFFSET_DB`) so speech reads as "conversation level" rather than "silent". Verified on the device: speech
recorded at -42 dBFS RMS was clearly audible when played back with the default gain.

**On-screen prompts:** `show_message` / `hide_message` drive `robot.ui.showBalloon/hideBalloon`, and the recording
tools show "Listening..." while the mic is open, so the person knows when to speak. Verified on the device.

## mDNS (a stable `<name>.local` for the robot) does not work — investigated 2026-09-17

Motivation: the MCP client holds a hardcoded IP, so if the robot's address ever changes the client sends its bearer
token to whatever device now answers there. A `.local` name would avoid that. The host firmware **does** compile in
Moddable's `mdns` module (it is in `host/modules/connectivity/manifest.json` and preloaded), so a MOD can import it
without a firmware rebuild. It still cannot be made to work:

- Claiming a hostname succeeds: `new MDNS({hostName})` reports the name as claimed. The claim callback fires more
  than once, the first time with an **empty** name while probing is still running.
- Claiming alone is not enough. The robot answers **no** queries — not a multicast query from macOS, and not even a
  unicast query sent straight to its port 5353. So nothing ever refreshes a client's cache.
- Advertising a service, which would make the robot *announce* rather than wait to be asked, fails inside the host's
  compiled module: `mdns.add()` throws **`call: not a function`** on every attempt (five retries, 2 s apart), from
  its send path. A MOD cannot instrument or patch a module that is baked into the firmware.
- Even when announcing worked briefly, `add()`'s announcement burst stops after about 30 s, so the name would go
  stale anyway unless re-announced. Re-announcing via `remove()` + `add()` is worse than nothing: `remove()` sends
  a goodbye record (TTL 0) that flushes the name from every client cache.
- Nothing exposes Wi-Fi power-save control (no `esp_wifi_set_ps` binding in the Moddable modules, and the firmware
  never sets it), so the likely reason multicast never arrives cannot be addressed from a MOD either.

Conclusion: use the IP with a DHCP reservation. Upstream would need to fix `mdns.add()` on this target, and
probably disable Wi-Fi power saving, before a name is viable.
