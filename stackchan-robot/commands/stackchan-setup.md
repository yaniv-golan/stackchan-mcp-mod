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

If a server named `stackchan` already exists, this is usually a robot that moved to a new address. Say so, and
remove the old one with `claude mcp remove stackchan` before adding it again — only after the user agrees.

## 4. Confirm

Tell the user to restart Claude Code so the server loads, then to run `/mcp` to see `stackchan` connected. Once it
is, `get_robot_info` reports the MOD version and what is on screen, which is the quickest proof the whole path
works.

Report the address you registered and whether the health check passed. Do not claim the robot is working if you
only registered it — the tools do not load until the session restarts.
