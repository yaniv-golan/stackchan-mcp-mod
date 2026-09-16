import Net from 'net'
import Time from 'time'
import Timer from 'timer'

// Long enough for the HTTP response to be written before the reboot cuts the connection.
const RESTART_DELAY_MS = 400

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

export function systemTools(robot, info) {
  return [
    {
      name: 'get_robot_info',
      description:
        'Report what this robot is: MOD version, uptime, network address, which hardware the MOD could reach, and the limits worth knowing before calling other tools.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        const lines = []
        lines.push(`MOD: ${info.name} v${info.version}, ${info.toolCount} tools`)
        lines.push(`Uptime: ${Math.round(Time.ticks / 1000)} s`)
        try {
          const address = Net.get('IP')
          lines.push(`Address: http://${address ?? 'unknown'}:${info.port}/mcp`)
        } catch (error) {
          lines.push(`Address: unavailable (${errorMessage(error)})`)
        }
        lines.push('Speech: say_message uses the configured TTS engine and returns only after playback ends')
        lines.push(`Camera: ${robot.camera && robot.camera.available !== false ? 'available' : 'not available'}`)
        const ledNames = Object.keys(robot.lighting?.led ?? {})
        lines.push(`LED groups: ${ledNames.length ? ledNames.join(', ') : 'none'}`)
        lines.push(`Microphone: ${robot.audio?.microphone ? 'available' : 'not available'}`)
        if (info.policy) lines.push(info.policy.describe())
        lines.push(
          'Limits: a response body much over 28 KB cannot be sent by this device (and taking it down is the failure mode), so photos are size-budgeted and recordings are returned downsampled or as a loudness summary.',
        )
        lines.push(
          "Display warning: a software restart (restart_robot, or the host MOD manager) leaves this robot's screen dead until someone power-cycles it by hand - hold the power button until it powers off, then press it again. A hardware reset (the bottom reset button) is safe and keeps the display working.",
        )
        return lines.join('\n')
      },
    },
    {
      name: 'restart_robot',
      description:
        'Reboot the robot in software. WARNING: on this hardware a software restart leaves the SCREEN DEAD until someone physically power-cycles the robot (hold the power button until it powers off, then press again) - a CPU reset does not re-initialize the display panel, though everything else works. Prefer the bottom reset button, which is safe. Only use this when nobody can reach the robot and a blank screen is acceptable. Unreachable for roughly 20 seconds; any held head pose is released.',
      inputSchema: {
        type: 'object',
        properties: {
          accept_display_blank: {
            type: 'boolean',
            description: 'Must be true: acknowledges that the screen will stay blank until a manual power-cycle',
          },
        },
        required: ['accept_display_blank'],
      },
      handler: (args) => {
        if (args.accept_display_blank !== true) {
          throw new Error(
            'restarting in software leaves the screen dead until a manual power-cycle; pass accept_display_blank: true if that is acceptable, or use the bottom reset button instead',
          )
        }
        const restart = globalThis.System?.restart
        if (typeof restart !== 'function') throw new Error('this firmware does not expose a soft restart')
        Timer.set(() => {
          try {
            globalThis.System.restart()
          } catch (error) {
            trace(`[mcp-mod] restart failed: ${errorMessage(error)}\n`)
          }
        }, RESTART_DELAY_MS)
        return 'Restarting now; the robot should answer again in about 20 seconds. The screen will stay blank until someone power-cycles it by hand.'
      },
    },
  ]
}

export default systemTools
