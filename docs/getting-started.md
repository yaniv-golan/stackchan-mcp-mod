# Getting started

The whole path, from a robot still in its box to one answering MCP calls on your LAN. If your robot already
runs stack-chan firmware, start at step 2.

Every step here needs the robot physically in front of you. None of it can be done over the network.

## What you need

- An **M5StackChan CoreS3**. Other stack-chan hardware may work; the measurements and workarounds in
  [device-notes.md](device-notes.md) are all from a CoreS3 and several are specific to it.
- A USB-C cable that carries data.
- **Moddable SDK 9.0.0 exactly.** The device rejects a MOD whose XS version does not match the host.
- A **stack-chan v1.1.0** checkout, for the platform config. You do not need ESP-IDF: `mcrun` compiles
  JavaScript, it does not build firmware.

## 1. Put stack-chan firmware on the robot

A new CoreS3 ships with M5's own firmware. Everything in this repository assumes **stack-chan v1.1.0**, which
you flash yourself from the project's release:

```sh
esptool --chip esp32s3 --port /dev/cu.usbmodem* write-flash \
  0x0 bootloader.bin  0x8000 partition-table.bin  0x10000 stack-chan.bin
```

Take a full backup of the original flash first if you may ever want to go back — it is a 16 MB read and it
contains the factory Wi-Fi credentials, so treat the file as a secret.

> The serial port number is not stable across re-plugs. Use `ls /dev/cu.usbmodem*` rather than a number you
> wrote down earlier.

## 2. Set the robot's preferences over BLE

The robot needs Wi-Fi, a TTS engine and a token before it serves anything. `POST /mcp` rejects every request
while `mcp.token` is unset.

Generate a token and keep it out of your shell history and out of this repository:

```sh
openssl rand -hex 32
```

Then write the preferences. **The order matters and is easy to get wrong:**

1. Start `scripts/set-prefs.py` first — it scans for up to 150 seconds.
2. *Then* press the robot's bottom reset button.
3. Tap the gear on the three-second splash screen, and leave the Settings screen open.
4. After the writes land, press reset again **without touching the screen**, so the MOD reloads.

```sh
uv run --with bleak scripts/set-prefs.py \
  wifi.ssid=YourNetwork wifi.password=@env:WIFI_PASSWORD \
  tts.type=openai tts.token=@env:OPENAI_API_KEY tts.voice=alloy tts.speed=1 tts.volume=0.5 \
  mcp.token=@keychain:stackchan-mcp-token
```

`@env:` reads from a `.env` beside the script or at the repository root; `@keychain:` reads from the macOS
Keychain. Neither value is ever printed.

## 3. Decide the capture policy now, not later

The robot is about to become a networked camera and microphone. `mcp.capture` decides whether those tools
exist at all, and **it can only be set over BLE** — changing it later means repeating step 2's whole dance.

| Value | Effect |
|---|---|
| `open` (default) | Camera and microphone always work |
| `armed` | They refuse unless someone swiped the robot's head strip in the last 10 minutes |
| `off` | They are never registered, so a client never learns they exist |

Read [SECURITY.md](../SECURITY.md) before choosing. If the robot will be reachable by any client you did not
configure yourself — which includes [remote access](remote-access.md) — the answer is `off`.

## 4. Build and install the MOD

```sh
git clone --depth 1 --branch 9.0.0 https://github.com/Moddable-OpenSource/moddable ~/moddable
# add the prebuilt tools for your host from the 9.0.0 release into $MODDABLE/build/bin/mac/release
git clone --depth 1 --branch v1.1.0 https://github.com/stack-chan/stack-chan ~/stack-chan

MODDABLE=~/moddable STACKCHAN=~/stack-chan scripts/build.sh
STACKCHAN_PORT=/dev/cu.usbmodem1101 scripts/install.sh
```

The archive goes to the `xs` partition at `0xfa0000` (256 KB) and replaces whatever MOD was there. To roll
back, write the stock `mcp.xsa` from the v1.1.0 MOD gallery to the same offset.

> If esptool reports "No serial data received", press the bottom reset button **while it retries**. That needs
> a hand on the device, which is why this step cannot be done remotely.

## 5. Find it on the network

The address comes from DHCP and changes whenever the robot joins a different network.

```sh
arp -an | grep -i '7c:4f:ad'                                  # the CoreS3 MAC prefix
curl -s http://<robot-ip>:8080/health                          # {"status":"ok"}
```

`GET /health` needs no token and is the fastest way to tell "the robot is there" from "the robot is not".

## 6. Register it with your client

With the plugin installed, `/stackchan-robot:setup` does this for you — it finds the robot, health-checks it,
and passes the token straight from the Keychain without it reaching the transcript. By hand:

```sh
claude mcp add --scope user --transport http stackchan http://<robot-ip>:8080/mcp \
  --header "Authorization: Bearer $(security find-generic-password -s stackchan-mcp-token -a stackchan -w)"
```

Confirm it works before going further:

```sh
STACKCHAN_HOST=<robot-ip> make tools        # lists what the robot serves
STACKCHAN_HOST=<robot-ip> make selftest     # read-only checks, changes nothing
```

**Get this working on the LAN before adding anything else.** If you go straight to
[remote access](remote-access.md) and something is wrong, you are debugging two layers at once.

## What to read next

- [SECURITY.md](../SECURITY.md) — what installing this exposes, and the controls that survive a change of client.
- [remote-access.md](remote-access.md) — reaching the robot from a Cowork cloud session.
- [device-notes.md](device-notes.md) — the empirical record. Consult it before assuming a surprising behaviour
  is a bug in this code; several are firmware behaviour with no fix.
- [tool-reference.md](tool-reference.md) — every tool and argument, generated from a live robot.
