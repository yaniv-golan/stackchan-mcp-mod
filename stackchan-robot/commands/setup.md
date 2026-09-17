---
description: Register a Stack-chan robot with Claude Code, finding it on the network and taking its token from the Keychain
argument-hint: "[robot-ip]"
allowed-tools: Bash(arp:*), Bash(curl:*), Bash(claude mcp:*), Bash(security find-generic-password:*)
---

Register the user's Stack-chan robot as an MCP server. The plugin ships the operating skill; this connects the
robot the skill describes.

**Never print the bearer token, and never read it into your reply.** Pass it by command substitution so it goes
straight from the Keychain into the command that needs it.

## 1. Find the robot

If `$1` is set, use it as the address. Otherwise look for the robot by MAC prefix in the ARP table:

```sh
arp -an | grep -i '7c:4f:ad'
```

That prefix matches the CoreS3 used here; if the user's robot differs, or the table is empty, ask them for the
address rather than guessing. An empty table usually means nothing has talked to the robot recently — ask them to
confirm it is powered and on the same network, and note that its address changes whenever it joins a new one.

Confirm what you found before using it:

```sh
curl -s --max-time 6 -o /dev/null -w '%{http_code}\n' http://<ip>:8080/health
```

`200` means the robot is there. Anything else: stop and report it rather than registering an address that does not
answer.

## 2. Check the token exists

```sh
security find-generic-password -s stackchan-mcp-token -a stackchan -w >/dev/null && echo present
```

If it is missing, stop and tell the user to set `mcp.token` on the robot and store the same value in the Keychain
under service `stackchan-mcp-token`, account `stackchan` — `README.md` covers generating one. Do not invent a token
and do not proceed without one.

## 3. Register it

```sh
claude mcp add --scope user --transport http stackchan http://<ip>:8080/mcp \
  --header "Authorization: Bearer $(security find-generic-password -s stackchan-mcp-token -a stackchan -w)"
```

First check whether one is already registered:

```sh
claude mcp get stackchan 2>/dev/null | grep -i '^  URL:'
```

- **No entry** → add it.
- **An entry with the same address you just health-checked** → nothing needs doing. Say so and stop. Do not
  re-register, and do not ask the user whether to: there is no difference to apply, and a prompt with only one
  sensible answer is noise.
- **An entry with a different address** → this is a robot that moved networks. Say what is registered and what you
  found, and remove the old one with `claude mcp remove stackchan -s user` before adding it again — only after the
  user agrees.

## 4. Confirm

If the robot's tools are already available in this session, call `get_robot_info` and report the MOD version and
what is on screen. That is the whole path proven, and no restart is needed — do not tell the user to restart when
the tools are already there.

If you have just added or changed the registration, the tools do **not** load until Claude Code restarts. Say that
plainly, and do not claim the robot is working: you registered an address that answered a health check, which is
not the same thing. Tell the user to restart and then run `/mcp` to see `stackchan` connected.

Either way, report the address and whether the health check passed.
