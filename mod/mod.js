import Net from 'net'
import { onContextCreated as onDefaultContextCreated } from 'app-default-behavior/on-context-created'
import { createCapturePolicy } from 'capture-policy'
import { createSmileFace, describeEmotionIntensity, setEmotionIntensity } from 'face-smile'
import { EmotionNames, emotionFromName } from 'face-state'
import { probeBalloonFont } from 'font-probe'
import { createIndicators } from 'indicators'
import { MCPServer } from 'mcp-server-rich'
import { appearanceTools } from 'tools-appearance'
import { audioTools } from 'tools-audio'
import { cameraTools } from 'tools-camera'
import { createEvents } from 'tools-events'
import { micGainTools } from 'tools-mic-gain'
import { motionTools } from 'tools-motion'
import { powerTools } from 'tools-power'
import { qrTools } from 'tools-qr'
import { systemTools } from 'tools-system'

const VERSION = '0.3.0'
const MCP_PORT = 8080
const DRAWER_KEY = 'mcp-server:endpoint'

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

async function endpointMessage(robot, server) {
  // `status` is 'failed' only during the backoff sleep - every retry sets it back to 'running' before
  // listen() is even entered - so a listener that is dying and rebinding shows as healthy here most of the
  // time. The restart count is the part that persists, and this drawer entry is the only diagnostic a
  // person has when the tools cannot answer, so it has to carry it.
  const restarts = server.restarts ?? 0
  const history = restarts > 0 ? `\n(listener restarted ${restarts}x; last: ${server.error ?? 'unknown'})` : ''
  if (server.status === 'failed') return `MCP server error:\n${server.error ?? 'failed to start'}${history}`
  try {
    const network = robot.connectivity.network
    if (!network) return `MCP server unavailable:\nnetwork is not supported${history}`
    const ready = await network.ready
    if (ready.status !== 'connected') return `MCP server unavailable:\n${ready.reason}${history}`
    const address = Net.get('IP')
    if (!address) return `MCP server unavailable:\nIP address is not available${history}`
    return `MCP server:\nhttp://${address}:${MCP_PORT}/mcp${history}`
  } catch (error) {
    return `MCP server unavailable:\n${errorMessage(error)}`
  }
}

function emotionTools(robot) {
  return [
    {
      name: 'set_emotion',
      description:
        'Change the robot facial expression. All eight emotions change the mouth and eyebrows. intensity (0..1, ' +
        'default 0.7) scales how strongly it is drawn, so a mild mood and a strong one look different; it is ' +
        'quantized to three levels and persists until the next call that sets it.',
      inputSchema: {
        type: 'object',
        properties: {
          emotion: { type: 'string', enum: [...EmotionNames], description: 'Emotion to show' },
          intensity: {
            type: 'number',
            description: 'How strongly to express it, 0..1 (default 0.7, unchanged if omitted)',
          },
        },
        required: ['emotion'],
      },
      handler: (args) => {
        const name = typeof args.emotion === 'string' ? args.emotion.toUpperCase() : ''
        const emotion = emotionFromName(name)
        if (emotion === undefined) throw new Error(`emotion must be one of ${EmotionNames.join(', ')}`)
        if (args.intensity !== undefined) {
          if (typeof args.intensity !== 'number' || !Number.isFinite(args.intensity)) {
            throw new Error('intensity must be a number')
          }
          // Set the weight before the emotion so the face never paints the old emotion at the new
          // intensity for a frame.
          setEmotionIntensity(args.intensity)
        }
        robot.face.setEmotion(emotion)
        return `Robot emotion changed to: ${name} (intensity: ${describeEmotionIntensity()})`
      },
    },
  ]
}

function speechTools(robot) {
  return [
    {
      name: 'say_message',
      description:
        'Speak a message aloud with the configured TTS engine. Returns after playback ends, so keep messages short.',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string', description: 'Text to speak' } },
        required: ['message'],
      },
      handler: async (args) => {
        if (typeof args.message !== 'string' || args.message.length === 0) throw new Error('message is required')
        const result = await robot.audio.say(args.message)
        if (!result.success) throw new Error(`speech failed: ${result.reason}`)
        return `Robot said: "${result.value}"`
      },
    },
  ]
}

export function onContextCreated(robot, option) {
  trace(`[mcp-mod] starting v${VERSION}\n`)

  // A MOD's onContextCreated replaces the host default, so run the default first to keep
  // petting, IMU reactions, button handlers and the stock drawer entries.
  try {
    onDefaultContextCreated(robot, option)
    trace('[mcp-mod] default behaviors installed\n')
  } catch (error) {
    trace(`[mcp-mod] default behaviors failed: ${errorMessage(error)}\n`)
  }

  // Resolve the larger balloon font now, on our own stack, where a failure is catchable: Piu's lazy
  // lookup would otherwise throw from inside a later layout pass and reboot the device. Nothing uses
  // the answer yet; get_robot_info reports it.
  probeBalloonFont()

  const policy = createCapturePolicy(robot)
  const indicators = createIndicators(robot)
  trace(`[mcp-mod] ${policy.describe()}\n`)
  const events = createEvents(robot)
  const tools = [
    ...emotionTools(robot),
    ...speechTools(robot),
    ...motionTools(robot),
    ...appearanceTools(robot),
    ...qrTools(robot),
    ...events.tools,
    ...cameraTools(robot, { policy, indicators }),
    ...audioTools(robot, { policy, indicators }),
    ...micGainTools(),
    ...powerTools(),
  ]
  const info = { name: 'stackchan-mcp-mod', version: VERSION, port: MCP_PORT, toolCount: 0, policy }
  tools.push(...systemTools(robot, info))
  info.toolCount = tools.length
  // Replace the face with one that actually smiles for HAPPY, and that reports touches on the face
  // area - the only way a MOD can see screen touches, since the touch chip cannot be opened twice.
  try {
    robot.ui.setFace(createSmileFace({ onTouch: events.recordScreenTouch }))
    events.noteFaceTouchSource()
    trace('[mcp-mod] custom smile face installed\n')
  } catch (error) {
    trace(`[mcp-mod] custom face failed: ${errorMessage(error)}\n`)
  }

  const server = new MCPServer({ port: MCP_PORT, tools, name: 'stackchan-mcp-mod', version: VERSION })
  // systemTools closed over `info` above; get_robot_info reads server state lazily, so assigning it here
  // - after the server exists, before any request can arrive - is in time.
  info.server = server

  let endpointVisible = false
  try {
    robot.ui.drawer.addDrawerButton({
      key: DRAWER_KEY,
      label: 'MCP Server',
      kind: 'toggle',
      initialState: false,
      callback: async (context) => {
        try {
          endpointVisible = !endpointVisible
          context.ui.drawer.setDrawerButtonState(DRAWER_KEY, endpointVisible)
          if (!endpointVisible) {
            context.ui.hideBalloon()
            return
          }
          const message = await endpointMessage(context, server)
          if (endpointVisible) context.ui.showBalloon(message)
        } catch (error) {
          trace(`[mcp-mod] drawer error: ${errorMessage(error)}\n`)
        }
      },
    })
  } catch (error) {
    trace(`[mcp-mod] drawer button failed: ${errorMessage(error)}\n`)
  }

  trace(`[mcp-mod] ${tools.length} tools: ${tools.map((tool) => tool.name).join(', ')}\n`)
}
