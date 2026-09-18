# Reaching the robot from a Cowork cloud session

Get the robot working on your LAN first — [getting-started.md](getting-started.md) — then come back here.

## Why the obvious thing does not work

A cloud session cannot dial your robot. Anthropic's sandbox refuses private, internal and link-local
addresses, and a remote MCP connector is dialled from Anthropic's infrastructure rather than from your
machine, so it would need the robot to be publicly reachable. [SECURITY.md](../SECURITY.md) says not to do
that, and means it: this device's HTTP layer has an unfixed unauthenticated reboot.

## The Claude Desktop bridge

Desktop proxies MCP servers from its own config into a cloud Cowork session. The proxy process runs on **your**
machine, so it reaches the robot over the LAN and the robot never has a port open to the internet.

Verified end to end on 2026-09-18: a cloud Cowork session called `get_robot_info` and got an answer from the
robot on the LAN.

In `~/Library/Application Support/Claude/claude_desktop_config.json`, with `mcp-remote` as a stdio-to-HTTP
shim — this file is **not** the same as Claude Code's `~/.claude.json`, and looking in the wrong one will
convince you no bridge exists:

```json
{
  "mcpServers": {
    "stackchan": {
      "command": "npx",
      "args": ["-y", "mcp-remote@0.14.2", "http://ROBOT-IP-HERE:8080/mcp", "--allow-http",
               "--header", "Authorization: Bearer PASTE-YOUR-TOKEN-HERE"]
    }
  }
}
```

Restart Desktop, then confirm in `~/Library/Logs/Claude/main.log`:

```
[LocalMcpServerManager] Connected to stackchan (N tools)
[localMcpBridge] announcing stackchan: N tool(s)
```

## Three things that cost time

- **`--allow-http` is mandatory.** Without it `mcp-remote` exits immediately with "Non-HTTPS URLs are only
  allowed for localhost", which reads exactly like an unreachable robot.
- **Pin the version forward, not back.** Versions 0.0.5 to 0.1.15 carried a critical RCE (CVE-2025-6514).
  0.1.16 is merely the oldest fixed release, not a good choice today.
- **A normal Claude Desktop chat cannot see a bridged server.** It reports the tools missing, which looks
  exactly like a broken setup. The bridge feeds Cowork, not Desktop's own conversations. The log above is
  what settles it — both lines have appeared within seconds of a restart while the chat still insisted
  nothing was connected.

## What it costs

**Desktop must stay open.** Close it and the robot vanishes from the cloud session mid-conversation.

**Recovery is much slower than the outage.** After a robot reboot the bridge exhausts its retries and marks
the server failed. Measured once: the robot served normally for **17 minutes** before Desktop retried.
Nothing on the Cowork side can hurry it — only Desktop's own reconnect restores it. `Connection closed` in
the log means the robot is not answering, not that the proxy is broken.

**The token crosses your LAN in cleartext on every call.** That is what `--allow-http` means. The network
still protects you from outsiders, but not from anything already on the segment: a guest network, an IoT
VLAN, or one compromised device on the same SSID can read the token, and the token is the entire
authentication story. If the robot shares a flat home network with everything else, this is the realistic
threat and it is the one a "the port isn't exposed, so I'm fine" mental model will not prompt you to check.

**The token spreads.** It ends up in the robot's preferences, in the Desktop config in cleartext, on the wire
in cleartext on every call, and in whatever session transcripts and logs happened to quote it. Treat a token
that has been through this as exposed, and **rotate it as a pair** — the robot's `mcp.token` preference *and*
the Desktop config — or the bridge simply stops working.

**`npx -y` re-resolves from the npm registry at every Desktop launch** and installs without prompting.
Pinning the exact version is worth keeping, but there is no integrity pin, so the trust root is npm at launch
time for a config that drives physical hardware.

## What gates a call on this path

Claude Code's `permissions.ask` rules **do not apply here**. Nothing in this path goes through Claude Code —
it is Desktop, then `mcp-remote`, then the robot — so rules you set there are never consulted.

What does gate the call is **Claude Desktop's own MCP tool-approval prompt**. That is the control to configure
and reason about on this path. Do not assume the protections you set up for LAN use came with you.

And the control that survives every client, because the MOD enforces it from flash and no tool can change it,
is `mcp.capture`. If the robot can be reached by a client you did not configure yourself — which is what this
whole document sets up — set it to `off` and the camera and microphone tools are never registered at all.
