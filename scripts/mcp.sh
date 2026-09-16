#!/usr/bin/env bash
# Send one JSON-RPC message to the robot's MCP endpoint.
# Usage: scripts/mcp.sh '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# Env: STACKCHAN_HOST (ip[:port]), STACKCHAN_TOKEN (or macOS Keychain item "stackchan-mcp-token").
set -euo pipefail
HOST=${STACKCHAN_HOST:?set STACKCHAN_HOST to the robot IP}
case "$HOST" in *:*) ;; *) HOST="$HOST:8080" ;; esac
TOKEN=${STACKCHAN_TOKEN:-$(security find-generic-password -s stackchan-mcp-token -a stackchan -w 2>/dev/null || true)}
: "${TOKEN:?set STACKCHAN_TOKEN}"
curl -sS --max-time "${MCP_TIMEOUT:-90}" -X POST "http://$HOST/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" -d "$1"
echo
