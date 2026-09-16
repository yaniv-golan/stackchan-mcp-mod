/*
 * Makes camera and microphone use impossible to miss from across the room.
 *
 * A screen prompt is not enough: this hardware's display is frequently blank after a warm reset, and a
 * photo previously happened with no indication at all. So a capture lights the head ring for its whole
 * duration and a photo plays a short chirp. Both channels work with a dead screen.
 *
 * The LED write clobbers whatever pattern the LED tools last set; that is deliberate — an indicator
 * that can be suppressed by an earlier call is not an indicator.
 */
const CAMERA_COLOR = { r: 255, g: 40, b: 0 }
const MICROPHONE_COLOR = { r: 0, g: 80, b: 255 }
const CHIRP_HZ = 2200
const CHIRP_MS = 70
const CHIRP_VOLUME = 0.35

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

export function createIndicators(robot) {
  const ledName = Object.keys(robot.lighting?.led ?? {})[0]

  const light = (color) => {
    if (!ledName) return
    try {
      robot.lighting.lightOn(ledName, color.r, color.g, color.b)
    } catch (error) {
      trace(`[mcp-mod] indicator on failed: ${errorMessage(error)}\n`)
    }
  }

  const clear = () => {
    if (!ledName) return
    try {
      robot.lighting.lightOff(ledName)
    } catch (error) {
      trace(`[mcp-mod] indicator off failed: ${errorMessage(error)}\n`)
    }
  }

  const balloon = (text) => {
    try {
      robot.ui.showBalloon(text)
    } catch (error) {
      trace(`[mcp-mod] indicator balloon failed: ${errorMessage(error)}\n`)
    }
  }

  const hideBalloon = () => {
    try {
      robot.ui.hideBalloon()
    } catch (error) {
      trace(`[mcp-mod] indicator balloon hide failed: ${errorMessage(error)}\n`)
    }
  }

  return {
    /** Runs `action` with the camera indicator lit, a chirp first so the capture is audible. */
    async camera(action) {
      light(CAMERA_COLOR)
      balloon('Taking photo')
      try {
        await robot.audio.tone(CHIRP_HZ, CHIRP_MS, CHIRP_VOLUME)
      } catch (error) {
        trace(`[mcp-mod] indicator chirp failed: ${errorMessage(error)}\n`)
      }
      try {
        return await action()
      } finally {
        hideBalloon()
        clear()
      }
    },

    /** Runs `action` with the microphone indicator lit. No chirp: it would land in the recording. */
    async microphone(text, action) {
      light(MICROPHONE_COLOR)
      balloon(text)
      try {
        return await action()
      } finally {
        hideBalloon()
        clear()
      }
    },
  }
}

export default createIndicators
