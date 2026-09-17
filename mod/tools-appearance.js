/*
 * Appearance tools for stackchan-mcp-mod: the head-ring LEDs (robot.lighting.*), the face
 * (robot.face.*) and on-screen speech balloons (robot.ui.*) as MCP tools.
 */
import { hideBalloon, showBalloon } from 'balloon'
import { noteScreen } from 'robot-state'
import Timer from 'timer'
const BYTE_MIN = 0
const BYTE_MAX = 255
const LED_INDEX_MIN = 0
const LED_INDEX_MAX = 11
const LED_COUNT_MIN = 1
const LED_COUNT_MAX = 12
const LED_DURATION_MIN_MS = 0
const LED_DURATION_MAX_MS = 60000
const BLINK_DURATION_MIN_MS = 50
const BLINK_DURATION_MAX_MS = 5000
const BALLOON_SIZES = ['small', 'medium', 'large']
const OPEN_MIN = 0
const OPEN_MAX = 1

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function requireByte(args, name) {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} is required and must be a number`)
  return Math.round(clamp(value, BYTE_MIN, BYTE_MAX))
}

function requireUnit(args, name) {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} is required and must be a number`)
  return clamp(value, OPEN_MIN, OPEN_MAX)
}

function optionalIndexAndCount(args) {
  let index
  let count
  if (args.index !== undefined) {
    if (typeof args.index !== 'number' || !Number.isFinite(args.index)) throw new Error('index must be a number')
    index = Math.round(clamp(args.index, LED_INDEX_MIN, LED_INDEX_MAX))
  }
  if (args.count !== undefined) {
    if (typeof args.count !== 'number' || !Number.isFinite(args.count)) throw new Error('count must be a number')
    count = Math.round(clamp(args.count, LED_COUNT_MIN, LED_COUNT_MAX))
  }
  return { index, count }
}

const ledRangeProperties = {
  index: { type: 'integer', description: 'First LED index to affect, 0..11 (default: all LEDs)' },
  count: { type: 'integer', description: 'Number of LEDs to affect starting at index, 1..12 (default: all LEDs)' },
}

const rgbProperties = {
  r: { type: 'integer', description: 'Red, 0..255' },
  g: { type: 'integer', description: 'Green, 0..255' },
  b: { type: 'integer', description: 'Blue, 0..255' },
}

function ledTools(robot, ledName) {
  return [
    {
      name: 'set_leds',
      description:
        'Set the head-ring LEDs (12 LEDs on CoreS3) to a solid color. r/g/b are clamped to 0..255. Optionally ' +
        'limit the effect to a range of LEDs with index (0..11) and count (1..12), and optionally auto-turn-off ' +
        'after duration_ms milliseconds.',
      inputSchema: {
        type: 'object',
        properties: {
          ...rgbProperties,
          duration_ms: {
            type: 'number',
            description: 'If set, automatically turn the LEDs off after this many milliseconds (0..60000)',
          },
          ...ledRangeProperties,
        },
        required: ['r', 'g', 'b'],
      },
      handler: (args) => {
        const r = requireByte(args, 'r')
        const g = requireByte(args, 'g')
        const b = requireByte(args, 'b')
        let duration
        if (args.duration_ms !== undefined) {
          if (typeof args.duration_ms !== 'number' || !Number.isFinite(args.duration_ms)) {
            throw new Error('duration_ms must be a number')
          }
          duration = clamp(args.duration_ms, LED_DURATION_MIN_MS, LED_DURATION_MAX_MS)
        }
        const { index, count } = optionalIndexAndCount(args)
        robot.lighting.lightOn(ledName, r, g, b, duration, index, count)
        return `LEDs set to rgb(${r}, ${g}, ${b})${duration !== undefined ? ` for ${duration}ms` : ''}.`
      },
    },
    {
      name: 'blink_leds',
      description:
        'Blink the head-ring LEDs at a color. r/g/b are clamped to 0..255, duration_ms (the blink period) is ' +
        'clamped to 50..5000. Optionally limit the effect to a range of LEDs with index (0..11) and count (1..12).',
      inputSchema: {
        type: 'object',
        properties: {
          ...rgbProperties,
          duration_ms: { type: 'number', description: 'Blink period in milliseconds, clamped to 50..5000' },
          ...ledRangeProperties,
        },
        required: ['r', 'g', 'b', 'duration_ms'],
      },
      handler: (args) => {
        const r = requireByte(args, 'r')
        const g = requireByte(args, 'g')
        const b = requireByte(args, 'b')
        if (typeof args.duration_ms !== 'number' || !Number.isFinite(args.duration_ms)) {
          throw new Error('duration_ms is required and must be a number')
        }
        const duration = clamp(args.duration_ms, BLINK_DURATION_MIN_MS, BLINK_DURATION_MAX_MS)
        const { index, count } = optionalIndexAndCount(args)
        robot.lighting.lightBlink(ledName, r, g, b, duration, index, count)
        return `LEDs blinking rgb(${r}, ${g}, ${b}) every ${duration}ms.`
      },
    },
    {
      name: 'rainbow_leds',
      description:
        'Play a rainbow animation on the head-ring LEDs. Optionally limit the effect to a range of LEDs with ' +
        'index (0..11) and count (1..12).',
      inputSchema: { type: 'object', properties: { ...ledRangeProperties } },
      handler: (args) => {
        const { index, count } = optionalIndexAndCount(args)
        robot.lighting.lightRainbow(ledName, index, count)
        return 'LEDs playing a rainbow animation.'
      },
    },
    {
      name: 'leds_off',
      description:
        'Turn off the head-ring LEDs. Optionally limit the effect to a range of LEDs with index (0..11) and ' +
        'count (1..12).',
      inputSchema: { type: 'object', properties: { ...ledRangeProperties } },
      handler: (args) => {
        const { index, count } = optionalIndexAndCount(args)
        robot.lighting.lightOff(ledName, index, count)
        return 'LEDs turned off.'
      },
    },
  ]
}

function faceTools(robot) {
  return [
    {
      name: 'set_face_color',
      description:
        "Set a face theme color. 'primary' is the face/eye color, 'secondary' is the background color. r/g/b are " +
        'clamped to 0..255.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: ['primary', 'secondary'], description: 'Which theme color to set' },
          ...rgbProperties,
        },
        required: ['key', 'r', 'g', 'b'],
      },
      handler: (args) => {
        if (args.key !== 'primary' && args.key !== 'secondary') throw new Error("key must be 'primary' or 'secondary'")
        const r = requireByte(args, 'r')
        const g = requireByte(args, 'g')
        const b = requireByte(args, 'b')
        robot.face.setColor(args.key, r, g, b)
        return `Face ${args.key} color set to rgb(${r}, ${g}, ${b}).`
      },
    },
    {
      name: 'set_mouth_open',
      description: 'Set how open the mouth is, from 0 (closed) to 1 (fully open). value is clamped to 0..1.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'number', description: 'Mouth openness, 0 (closed) to 1 (fully open)' } },
        required: ['value'],
      },
      handler: (args) => {
        const value = requireUnit(args, 'value')
        robot.face.setMouthOpen(value)
        return `Mouth openness set to ${value.toFixed(2)}.`
      },
    },
    {
      name: 'set_eye_open',
      description:
        "Set how open one eye is, from 0 (closed) to 1 (fully open). key selects 'left' or 'right'. value is " +
        'clamped to 0..1.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: ['left', 'right'], description: 'Which eye to set' },
          value: { type: 'number', description: 'Eye openness, 0 (closed) to 1 (fully open)' },
        },
        required: ['key', 'value'],
      },
      handler: (args) => {
        if (args.key !== 'left' && args.key !== 'right') throw new Error("key must be 'left' or 'right'")
        const value = requireUnit(args, 'value')
        robot.face.setEyeOpen(args.key, value)
        return `${args.key} eye openness set to ${value.toFixed(2)}.`
      },
    },
  ]
}

function balloonTools(robot) {
  let hideTimer
  const clearHideTimer = () => {
    if (hideTimer === undefined) return
    Timer.clear(hideTimer)
    hideTimer = undefined
  }
  return [
    {
      name: 'show_message',
      description:
        'Show a short text message in a speech balloon on the robot screen. Useful for prompting the person in front of the robot (for example telling them when to speak). Keep it short; the balloon is small.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message to display' },
          seconds: {
            type: 'number',
            description: 'Hide the balloon automatically after this many seconds, 1..60 (default: leave it up)',
          },
          size: {
            type: 'string',
            enum: [...BALLOON_SIZES],
            description:
              'Text size (default medium). small is the host default, about 2 mm tall on this panel and hard to read across a room; medium and large are legible. A robot without the larger fonts falls back to small.',
          },
        },
        required: ['text'],
      },
      handler: (args) => {
        if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('text is required')
        // The balloon is small and the text is drawn, not scrolled; a long string is pointless here.
        const text = args.text.slice(0, 200)
        let seconds
        if (args.seconds !== undefined) {
          if (typeof args.seconds !== 'number' || !Number.isFinite(args.seconds)) {
            throw new Error('seconds must be a number')
          }
          seconds = clamp(args.seconds, 1, 60)
        }
        let size = 'medium'
        if (args.size !== undefined) {
          if (!BALLOON_SIZES.includes(args.size)) throw new Error(`size must be one of ${BALLOON_SIZES.join(', ')}`)
          size = args.size
        }
        clearHideTimer()
        const font = showBalloon(robot, text, size)
        noteScreen(`balloon "${text.slice(0, 24)}"`)
        if (seconds !== undefined) {
          hideTimer = Timer.set(() => {
            hideTimer = undefined
            hideBalloon(robot)
            noteScreen('face')
          }, seconds * 1000)
        }
        const rendered = font ? `at ${size} size` : 'at the default small size'
        return `Showing "${text}" ${rendered}${seconds === undefined ? '' : ` for ${seconds}s`}.`
      },
    },
    {
      name: 'hide_message',
      description: 'Hide the speech balloon shown by show_message.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        clearHideTimer()
        hideBalloon(robot)
        noteScreen('face')
        return 'Balloon hidden.'
      },
    },
  ]
}

export function appearanceTools(robot) {
  const ledNames = Object.keys(robot.lighting?.led ?? {})
  if (ledNames.length === 0) return [...faceTools(robot), ...balloonTools(robot)]
  return [...ledTools(robot, ledNames[0]), ...faceTools(robot), ...balloonTools(robot)]
}

export default appearanceTools
