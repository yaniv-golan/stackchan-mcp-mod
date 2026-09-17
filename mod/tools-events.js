import config from 'mc/config'
import Time from 'time'
import Timer from 'timer'
import Touch from 'touch'

const RING_CAPACITY = 64
// A long wait costs nothing in latency - the call returns the moment an event arrives - and a caller
// watching for activity makes far fewer round trips. 45 s stays inside a typical MCP client's own
// request timeout; going much higher risks the client abandoning a call while the robot still holds
// the connection. Callers wanting a shorter wait just pass a smaller timeout_ms.
const WAIT_TIMEOUT_MAX_MS = 45000
const VALID_KINDS = ['button', 'touch', 'touch-panel', 'imu']
const BUTTON_NAMES = ['a', 'b', 'c', 'power']
const VIRTUAL_BUTTON_NAMES = ['a', 'b', 'c']

/**
 * The host only builds a screen-touch object when `config.Touch` is set, which this platform leaves
 * unset, so `robot.input.touch` is undefined. The touch chip is still there behind the device provider,
 * so open it here to get screen touches. This is a second reader of that I2C device.
 */
function createScreenTouch() {
  const TouchConstructor = config.Touch ?? globalThis.device?.sensor?.Touch
  if (!TouchConstructor) return undefined
  return new Touch(TouchConstructor, {
    count: config.touchCount,
    intervalMs: config.touchIntervalMs,
    idleIntervalMs: config.touchIdleIntervalMs,
    activeIntervalMs: config.touchActiveIntervalMs,
    releaseDebounceMs: config.touchReleaseDebounceMs,
  })
}

/**
 * Matches the button shape the CoreS3 touch driver writes to: its sample() maps a touch below y=200
 * onto globalThis.button.a/b/c (three ~107px columns) whenever those objects exist. The platform build
 * sets virtualButton false so nothing creates them; creating them here turns the bottom strip of the
 * screen into three buttons, driven by the touch instance above.
 */
class VirtualButton {
  #value = 0
  read() {
    return this.#value
  }
  write(value) {
    if (this.#value === value) return
    this.#value = value
    this.onChanged?.()
  }
}

// host/modules/input/imu-motion.ts:12
const MOTION_TYPES = ['shake', 'fallenForward', 'fallenBackward', 'fallenLeft', 'fallenRight', 'upsideDown']
// host/modules/input/touch-panel-gesture.ts:3
const GESTURE_TYPES = ['press', 'release', 'forwardSwipe', 'backwardSwipe']

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function normalizeInteger(value, name, fallback, min, max) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function formatEvent(record) {
  const parts = [`seq=${record.seq}`, `kind=${record.kind}`, `ticks=${record.ticks}`]
  switch (record.kind) {
    case 'button':
      parts.push(`name=${record.name}`, `pressed=${record.pressed}`)
      break
    case 'touch':
      parts.push(`phase=${record.phase}`, `id=${record.id}`, `x=${record.x}`, `y=${record.y}`)
      break
    case 'touch-panel':
      parts.push(`gesture=${record.gesture}`, `position=${record.position}`, `intensity=${record.intensity}`)
      if (record.tap) {
        parts.push(
          `tap.durationMs=${record.tap.durationMs}`,
          `tap.maxMovement=${record.tap.maxMovement}`,
          `tap.position=${record.tap.position}`,
        )
      }
      break
    case 'imu':
      parts.push(`motion=${record.motion}`)
      break
  }
  return parts.join(' ')
}

export function createEvents(robot) {
  const buffer = []
  let nextSeq = 1
  const waiters = new Set()
  const attached = {
    touchPanel: false,
    touch: false,
    imu: false,
    button: { a: false, b: false, c: false, power: false },
  }
  let lastTouchX
  let lastTouchY

  function record(event) {
    let rec
    try {
      rec = { seq: nextSeq, ...event }
      nextSeq += 1
      buffer.push(rec)
      if (buffer.length > RING_CAPACITY) buffer.shift()
    } catch (error) {
      trace(`[mcp-mod] tools-events: record error: ${errorMessage(error)}\n`)
      return
    }
    for (const waiter of [...waiters]) {
      try {
        if (waiter.kind !== undefined && waiter.kind !== rec.kind) continue
        waiters.delete(waiter)
        Timer.clear(waiter.timer)
        waiter.resolve(rec)
      } catch (error) {
        trace(`[mcp-mod] tools-events: waiter dispatch error: ${errorMessage(error)}\n`)
      }
    }
  }

  // Head touch strip: subscribe() supports multiple listeners, so this never clobbers
  // the default behavior's own subscription (see on-context-created.ts).
  try {
    if (robot.input?.touchPanel?.subscribe) {
      robot.input.touchPanel.subscribe((event) => {
        try {
          record(event)
        } catch (error) {
          trace(`[mcp-mod] tools-events: touch-panel listener error: ${errorMessage(error)}\n`)
        }
      })
      attached.touchPanel = true
    }
  } catch (error) {
    trace(`[mcp-mod] tools-events: touch-panel attach failed: ${errorMessage(error)}\n`)
  }

  // IMU, screen touch and each button expose only a single onEvent slot. Chain onto whatever
  // is already installed (the default behavior fills these in first) instead of overwriting it,
  // so default IMU emotion reactions and button handlers keep working.
  function chain(source, label) {
    if (!source) return false
    try {
      const previous = source.onEvent
      source.onEvent = (event) => {
        try {
          record(event)
        } catch (error) {
          trace(`[mcp-mod] tools-events: ${label} record error: ${errorMessage(error)}\n`)
        }
        if (previous) {
          try {
            previous(event)
          } catch (error) {
            trace(`[mcp-mod] tools-events: ${label} chained handler error: ${errorMessage(error)}\n`)
          }
        }
      }
      return true
    } catch (error) {
      trace(`[mcp-mod] tools-events: ${label} attach failed: ${errorMessage(error)}\n`)
      return false
    }
  }

  attached.imu = chain(robot.input?.imu, 'imu')
  attached.touch = chain(robot.input?.touch, 'touch')
  for (const name of BUTTON_NAMES) {
    attached.button[name] = chain(robot.input?.button?.[name], `button.${name}`)
  }

  // Screen touch and the virtual bottom-row buttons, neither of which the host exposes on this platform.
  let ownScreenTouch
  if (!attached.touch) {
    try {
      ownScreenTouch = createScreenTouch()
      if (ownScreenTouch) {
        ownScreenTouch.onEvent = (event) => {
          try {
            record(event)
          } catch (error) {
            trace(`[mcp-mod] tools-events: screen touch record error: ${errorMessage(error)}\n`)
          }
        }
        attached.touch = true
        attached.touchOwned = true
        trace('[mcp-mod] tools-events: opened own screen touch instance\n')
      }
    } catch (error) {
      trace(`[mcp-mod] tools-events: screen touch open failed: ${errorMessage(error)}\n`)
    }
  }
  if (ownScreenTouch && globalThis.button) {
    for (const name of VIRTUAL_BUTTON_NAMES) {
      if (globalThis.button[name]) continue
      try {
        const button = new VirtualButton()
        button.onChanged = () => {
          try {
            record({ kind: 'button', name, pressed: Boolean(button.read()), ticks: Time.ticks })
          } catch (error) {
            trace(`[mcp-mod] tools-events: virtual button record error: ${errorMessage(error)}\n`)
          }
        }
        globalThis.button[name] = button
        attached.button[name] = true
        attached.virtualButtons = true
      } catch (error) {
        trace(`[mcp-mod] tools-events: virtual button ${name} failed: ${errorMessage(error)}\n`)
      }
    }
  }

  const tools = [
    {
      name: 'get_recent_events',
      description:
        "List recently recorded input events (button presses, screen touches, head touch-strip gestures, recognized IMU motions) from an in-memory ring buffer of the last 64 events. Each event's `ticks` is the device's millisecond clock, and the head touch strip reports gestures (press/release/forwardSwipe/backwardSwipe), not raw finger positions.",
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: VALID_KINDS, description: 'Only return events of this kind' },
          limit: { type: 'integer', description: 'Max events to return (default 20, clamped 1-64)' },
          since_seq: { type: 'integer', description: 'Only return events with seq greater than this value' },
        },
      },
      handler: (args) => {
        const kind = args.kind
        if (kind !== undefined && !VALID_KINDS.includes(kind)) {
          throw new Error(`kind must be one of ${VALID_KINDS.join(', ')}`)
        }
        const limit = normalizeInteger(args.limit, 'limit', 20, 1, RING_CAPACITY)
        const sinceSeq = normalizeInteger(
          args.since_seq,
          'since_seq',
          undefined,
          Number.NEGATIVE_INFINITY,
          Number.POSITIVE_INFINITY,
        )

        const highestSeq = buffer.length ? buffer[buffer.length - 1].seq : nextSeq - 1

        if (buffer.length === 0) {
          return `Event buffer is empty; no input events have been recorded yet. Highest seq: ${highestSeq}.`
        }

        let filtered = buffer
        if (kind !== undefined) filtered = filtered.filter((rec) => rec.kind === kind)
        if (sinceSeq !== undefined) filtered = filtered.filter((rec) => rec.seq > sinceSeq)

        if (filtered.length === 0) {
          const filters = []
          if (kind !== undefined) filters.push(`kind "${kind}"`)
          if (sinceSeq !== undefined) filters.push(`seq > ${sinceSeq}`)
          const filterText = filters.length ? ` matching ${filters.join(' and ')}` : ''
          return `No recorded events${filterText}. Highest seq overall: ${highestSeq}.`
        }

        const selected = filtered.slice(-limit)
        const lines = selected.map(formatEvent)
        return `${selected.length} event(s), newest last (highest seq overall: ${highestSeq}):\n${lines.join('\n')}`
      },
    },
    {
      name: 'wait_for_event',
      description:
        "Wait for the next input event recorded after this call starts, optionally filtered by kind, resolving as soon as it happens or after timeout_ms elapses. `ticks` is the device's millisecond clock; the head touch strip reports gestures, not raw positions.",
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: VALID_KINDS, description: 'Only resolve for an event of this kind' },
          timeout_ms: {
            type: 'integer',
            description:
              'Max time to wait in milliseconds (default 5000, clamped 100-45000). Waiting longer is cheap: the call returns as soon as an event arrives, so a long wait mainly avoids repeated empty polls. Prefer one long wait over several short ones.',
          },
        },
      },
      handler: (args) => {
        const kind = args.kind
        if (kind !== undefined && !VALID_KINDS.includes(kind)) {
          throw new Error(`kind must be one of ${VALID_KINDS.join(', ')}`)
        }
        const timeoutMs = normalizeInteger(args.timeout_ms, 'timeout_ms', 5000, 100, WAIT_TIMEOUT_MAX_MS)

        return new Promise((resolve) => {
          const waiter = { kind, timer: undefined, resolve: undefined }
          waiter.resolve = (rec) => resolve(`Event received: ${formatEvent(rec)}`)
          waiter.timer = Timer.set(() => {
            waiters.delete(waiter)
            resolve(`No event within ${timeoutMs} ms.`)
          }, timeoutMs)
          waiters.add(waiter)
        })
      },
    },
    {
      name: 'get_input_capabilities',
      description:
        'Report which input sources this robot exposes (head touch strip, screen touch, IMU, buttons a/b/c/power) and which ones this MOD is recording events from. The IMU only reports recognized motion gestures, not raw accelerometer samples.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        const lines = []
        const describe = (label, present, isAttached) =>
          `${label}: ${present ? (isAttached ? 'present, attached' : 'present, not attached') : 'not present on this robot'}`

        lines.push(describe('head touch strip (touch panel)', Boolean(robot.input?.touchPanel), attached.touchPanel))
        lines.push(
          `screen touch: ${
            attached.touchOwned
              ? 'opened by this MOD (the firmware does not expose it), reports x/y in screen pixels'
              : attached.touchFromFace
                ? 'reported by the MOD custom face, x/y in screen pixels, only for touches on the face area'
                : describe('screen touch', Boolean(robot.input?.touch), attached.touch).replace('screen touch: ', '')
          }`,
        )
        lines.push(describe('IMU', Boolean(robot.input?.imu), attached.imu))
        for (const name of BUTTON_NAMES) {
          const virtual = attached.virtualButtons && VIRTUAL_BUTTON_NAMES.includes(name)
          lines.push(
            `${describe(`button ${name}`, Boolean(robot.input?.button?.[name]) || virtual, attached.button[name])}${
              virtual ? ' (virtual: bottom row of the screen, left/middle/right)' : ''
            }`,
          )
        }
        lines.push(
          `IMU events report only recognized motion gestures, not raw accelerometer samples. Recognized motions: ${MOTION_TYPES.join(', ')}.`,
        )
        lines.push(
          `Head touch strip events report gestures, not raw touch positions. Recognized gestures: ${GESTURE_TYPES.join(', ')}.`,
        )
        return lines.join('\n')
      },
    },
  ]

  return {
    tools,
    /**
     * Declares that the custom face will report screen touches, so get_input_capabilities can say so
     * from boot. Waiting for the first touch to arrive would report the capability as absent until it
     * had been exercised, which misleads any client that probes at startup.
     */
    noteFaceTouchSource() {
      attached.touch = true
      attached.touchFromFace = true
    },

    /** Lets another component (the custom face) feed screen-touch events into the same buffer. */
    recordScreenTouch: (event) => {
      try {
        // Piu repeats onTouchMoved while a finger rests still; keeping those would flood the buffer.
        if (event.phase === 'moved' && event.x === lastTouchX && event.y === lastTouchY) return
        lastTouchX = event.x
        lastTouchY = event.y
        record(event)
        if (!attached.touch) {
          attached.touch = true
          attached.touchFromFace = true
        }
      } catch (error) {
        trace(`[mcp-mod] tools-events: face touch record error: ${errorMessage(error)}\n`)
      }
    },
  }
}

export default createEvents
