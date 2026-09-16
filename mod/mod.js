import Net from 'net'
import { onContextCreated as onDefaultContextCreated } from 'app-default-behavior/on-context-created'
import { createCapturePolicy } from 'capture-policy'
import { createSmileFace } from 'face-smile'
import { EmotionNames, emotionFromName } from 'face-state'
import { createIndicators } from 'indicators'
import { MCPServer } from 'mcp-server-rich'
import { appearanceTools } from 'tools-appearance'
import { audioTools } from 'tools-audio'
import { cameraTools } from 'tools-camera'
import { createEvents } from 'tools-events'
import { micGainTools } from 'tools-mic-gain'
import { motionTools } from 'tools-motion'
import { powerTools } from 'tools-power'
import { systemTools } from 'tools-system'

const VERSION = '0.1.0'
const MCP_PORT = 8080
const DRAWER_KEY = 'mcp-server:endpoint'

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

async function endpointMessage(robot, server) {
  if (server.status === 'failed') return `MCP server error:\n${server.error ?? 'failed to start'}`
  try {
    const network = robot.connectivity.network
    if (!network) return 'MCP server unavailable:\nnetwork is not supported'
    const ready = await network.ready
    if (ready.status !== 'connected') return `MCP server unavailable:\n${ready.reason}`
    const address = Net.get('IP')
    if (!address) return 'MCP server unavailable:\nIP address is not available'
    return `MCP server:\nhttp://${address}:${MCP_PORT}/mcp`
  } catch (error) {
    return `MCP server unavailable:\n${errorMessage(error)}`
  }
}

function emotionTools(robot) {
  return [
    {
      name: 'set_emotion',
      description: 'Change the robot facial expression.',
      inputSchema: {
        type: 'object',
        properties: { emotion: { type: 'string', enum: [...EmotionNames], description: 'Emotion to show' } },
        required: ['emotion'],
      },
      handler: (args) => {
        const name = typeof args.emotion === 'string' ? args.emotion.toUpperCase() : ''
        const emotion = emotionFromName(name)
        if (emotion === undefined) throw new Error(`emotion must be one of ${EmotionNames.join(', ')}`)
        robot.face.setEmotion(emotion)
        return `Robot emotion changed to: ${name}`
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

  const policy = createCapturePolicy(robot)
  const indicators = createIndicators(robot)
  trace(`[mcp-mod] ${policy.describe()}\n`)
  const events = createEvents(robot)
  const tools = [
    ...emotionTools(robot),
    ...speechTools(robot),
    ...motionTools(robot),
    ...appearanceTools(robot),
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
