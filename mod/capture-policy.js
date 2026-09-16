/*
 * Policy for the tools that can see and hear: `mcp.capture` preference, read once at boot.
 *
 *   open   (default) camera and microphone tools always work
 *   armed            they work only for a while after someone touches the robot's head
 *   off              they are not registered at all, so a client never learns they exist
 *
 * The point of `armed` is that software alone cannot open the camera: text that talks an assistant into
 * taking a photo still cannot produce one, because a hand has to be involved. That only holds if no tool
 * can change the policy or arm the robot - so neither is exposed as a tool, and arming comes from the
 * head touch strip or the on-screen drawer. The mode itself changes only over BLE preferences, which
 * needs physical access to the robot.
 */
import { DOMAIN } from 'consts'
import Preference from 'preference'
import Timer from 'timer'

const ARM_DURATION_MS = 10 * 60 * 1000
const ARM_INDICATOR_COLOR = { r: 255, g: 180, b: 0 }
const DRAWER_KEY = 'mcp-server:arm-capture'

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function readMode() {
  let value
  try {
    value = Preference.get(DOMAIN.mcp, 'capture')
  } catch (error) {
    trace(`[mcp-mod] capture policy read failed: ${errorMessage(error)}\n`)
  }
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (mode === 'off' || mode === 'armed' || mode === 'open') return mode
  if (mode) trace(`[mcp-mod] unknown mcp.capture value "${mode}", using open\n`)
  return 'open'
}

export function createCapturePolicy(robot) {
  const mode = readMode()
  const ledName = Object.keys(robot.lighting?.led ?? {})[0]
  // Deliberately a flag cleared by the disarm timer, not a `Time.ticks < armedUntil` comparison:
  // Time.ticks is a signed 32-bit millisecond counter that wraps negative after about 24.9 days, and
  // that comparison would then read as armed for the next 25 days while the LED showed disarmed.
  let armed = false
  let armedTimer

  const showArmedIndicator = (on) => {
    if (!ledName) return
    try {
      if (on)
        robot.lighting.lightOn(ledName, ARM_INDICATOR_COLOR.r, ARM_INDICATOR_COLOR.g, ARM_INDICATOR_COLOR.b, 0, 0, 1)
      else robot.lighting.lightOff(ledName, 0, 1)
    } catch (error) {
      trace(`[mcp-mod] arm indicator failed: ${errorMessage(error)}\n`)
    }
  }

  const arm = () => {
    armed = true
    showArmedIndicator(true)
    if (armedTimer !== undefined) Timer.clear(armedTimer)
    armedTimer = Timer.set(() => {
      armedTimer = undefined
      armed = false
      showArmedIndicator(false)
      trace('[mcp-mod] capture disarmed\n')
    }, ARM_DURATION_MS)
    trace(`[mcp-mod] capture armed for ${ARM_DURATION_MS / 1000}s\n`)
    try {
      robot.ui.showBalloon('Camera and mic armed')
      Timer.set(() => {
        try {
          robot.ui.hideBalloon()
        } catch (error) {
          trace(`[mcp-mod] arm balloon hide failed: ${errorMessage(error)}\n`)
        }
      }, 3000)
    } catch (error) {
      trace(`[mcp-mod] arm balloon failed: ${errorMessage(error)}\n`)
    }
  }

  if (mode === 'armed') {
    // Physical arming: a swipe on the head strip, or the drawer button for anyone who prefers the screen.
    try {
      robot.input?.touchPanel?.subscribe((event) => {
        try {
          if (event.gesture === 'forwardSwipe' || event.gesture === 'backwardSwipe') arm()
        } catch (error) {
          trace(`[mcp-mod] arm from touch failed: ${errorMessage(error)}\n`)
        }
      })
    } catch (error) {
      trace(`[mcp-mod] arm touch subscribe failed: ${errorMessage(error)}\n`)
    }
    try {
      robot.ui.drawer.addDrawerButton({
        key: DRAWER_KEY,
        label: 'Arm camera',
        callback: () => {
          try {
            arm()
            robot.ui.closeDrawer()
          } catch (error) {
            trace(`[mcp-mod] arm from drawer failed: ${errorMessage(error)}\n`)
          }
        },
      })
    } catch (error) {
      trace(`[mcp-mod] arm drawer button failed: ${errorMessage(error)}\n`)
    }
  }

  return {
    mode,

    /** Whether capture tools should be registered at all. */
    get enabled() {
      return mode !== 'off'
    },

    /** Throws when a capture is not currently allowed, with wording aimed at the assistant. */
    check(what) {
      if (mode !== 'armed') return
      if (armed) return
      throw new Error(
        `${what} is disarmed: this robot requires someone to physically swipe its head touch strip (or press "Arm camera" in its on-screen drawer) before the camera or microphone can be used. Ask the person with the robot to do that, then try again. This cannot be armed remotely, by design.`,
      )
    },

    /** One line for get_robot_info, so an operator can see the policy without reading preferences. */
    describe() {
      if (mode === 'off') return 'Capture policy: off - camera and microphone tools are not available.'
      if (mode === 'armed') {
        return `Capture policy: armed - camera and microphone need a touch on the robot's head first (currently ${armed ? 'armed' : 'disarmed'}).`
      }
      return 'Capture policy: open - camera and microphone are always available.'
    },
  }
}

export default createCapturePolicy
