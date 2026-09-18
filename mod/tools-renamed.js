/*
 * Refusing stubs for the four capture tools renamed to a shared camera_ / mic_ prefix (see
 * docs/internal/face-and-screen-tools-design.md), so a client can permission every capture tool
 * with one rule: mcp__stackchan__camera_*, mcp__stackchan__mic_*.
 *
 * A user who followed SECURITY.md has the old names under permissions.ask. After the rename those
 * rules match nothing, and if they also have a server-wide allow, capture would fire with no prompt -
 * Claude Code's stale-rule check does not catch this because it exempts any tool name containing `_`.
 * Registering these old names as stubs keeps a stale rule matching a real tool, so an old-name call
 * fails loudly with an explanation instead of silently 404-ing.
 *
 * Descriptions are kept to one short sentence each: tools/list is itself an HTTP response, subject to the
 * same body ceiling as a photo, and every byte here is pure overhead. It measured 16,819 bytes at 33
 * tools (2026-09-18) against a 24,000-byte check in scripts/selftest.py - comfortable, but it only grows.
 */

const RENAMES = [
  { from: 'take_photo', to: 'camera_take_photo' },
  { from: 'listen', to: 'mic_listen' },
  { from: 'get_recorded_audio', to: 'mic_get_audio' },
  { from: 'record_and_play', to: 'mic_record_and_play' },
]

export function renamedTools() {
  return RENAMES.map(({ from, to }) => ({
    name: from,
    description: `Renamed to \`${to}\`. Do not call this; call that instead and update your permission rules.`,
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      throw new Error(
        `'${from}' was renamed to '${to}'. Update your permissions.ask rules to use '${to}'; nothing was captured.`,
      )
    },
  }))
}

export default renamedTools
