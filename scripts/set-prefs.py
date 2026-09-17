#!/usr/bin/env python3
"""Write stack-chan preferences over BLE (robot must be in setup mode, advertising "STK").

Settings mode: press the bottom reset button, then tap the gear "Settings" button on the 3 s splash.

    uv run --with bleak scripts/set-prefs.py               # sets mcp.token from Keychain
    uv run --with bleak scripts/set-prefs.py key=value ... # arbitrary prefs, e.g. ui.language=en
    uv run --with bleak scripts/set-prefs.py tts.type=openai tts.token=@env:OPENAI_API_KEY
    uv run --with bleak scripts/set-prefs.py mcp.capture=armed   # require a head touch before capture
    uv run --with bleak scripts/set-prefs.py wifi.ssid=NewNetwork wifi.password=@env:WIFI_PASSWORD

Wi-Fi credentials are ordinary preferences, so this is how the robot moves to another network. It joins on the
next boot, its address changes, and nothing announces the new one - find it again by MAC in the ARP table and
re-register any client that had the old address.

Value references (never printed):
    @env:<NAME>          from .env (beside this script or at the repository root), else the environment
    @keychain:<service>  from macOS Keychain (account "stackchan")

The token is read from macOS Keychain (service "stackchan-mcp-token") and never printed.
Protocol: firmware/host/modules/connectivity/preference-server.ts (stack-chan/stack-chan v1.1.0).
"""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

from bleak import BleakClient, BleakScanner

DEVICE_NAME = "STK"
SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
SECRET_KEYS = {"mcp.token", "ai.token", "tts.token", "wifi.password"}


def keychain(service: str) -> str:
    return subprocess.run(
        ["security", "find-generic-password", "-s", service, "-a", "stackchan", "-w"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def dotenv(name: str) -> str:
    # Next to this script, then the repository root: .env lives at the root, the script in scripts/.
    here = Path(__file__).resolve().parent
    candidates = [here / ".env", here.parent / ".env"]
    for env_file in candidates:
        if not env_file.exists():
            continue
        for line in env_file.read_text().splitlines():
            key, sep, val = line.strip().partition("=")
            if sep and key.strip() == name and not key.lstrip().startswith("#"):
                val = val.strip().strip('"').strip("'")
                if val:
                    return val
    if os.environ.get(name):
        return os.environ[name]
    sys.exit(f"{name} is empty: add it to {candidates[-1]} or export it")


def resolve(value: str) -> str:
    if value.startswith("@keychain:"):
        return keychain(value.removeprefix("@keychain:"))
    if value.startswith("@env:"):
        return dotenv(value.removeprefix("@env:"))
    return value


def shown(prop, value):
    return f"<{len(str(value))} chars>" if prop in SECRET_KEYS and value else repr(value)


async def main():
    if len(sys.argv) > 1:
        batch = {k: resolve(v) for k, v in (arg.split("=", 1) for arg in sys.argv[1:])}
    else:
        batch = {"mcp.token": keychain("stackchan-mcp-token")}

    print("Scanning for STK (robot in setup mode)...")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=150.0)
    if device is None:
        sys.exit("STK not found. Press the bottom reset button and tap the gear on the 3 s splash, then retry.")

    current = {}

    def on_notify(_, data: bytearray):
        try:
            item = json.loads(data.decode("utf-8"))
            current[item["prop"]] = item.get("value")
        except (ValueError, KeyError):
            pass

    async with BleakClient(device) as client:
        await client.start_notify(TX, on_notify)
        await asyncio.sleep(2.0)  # let the robot report current values
        payload = json.dumps({"_batch": batch}, separators=(",", ":")).encode("utf-8")
        for i in range(0, len(payload), 128):
            await client.write_gatt_char(RX, payload[i:i + 128], response=True)
        await asyncio.sleep(3.0)
        for prop, value in batch.items():
            ok = current.get(prop) == value
            print(f"{prop}: sent {shown(prop, value)}; robot reports {shown(prop, current.get(prop))}"
                  f" -> {'OK' if ok else 'not confirmed'}")


if __name__ == "__main__":
    asyncio.run(main())
