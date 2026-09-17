/*
 * Does a larger balloon font exist on this host?
 *
 * The host image carries OpenSans-Regular-16/20/24 with full character sets, and the speech balloon
 * defaults to a 12 px bitmap font that is about 2 mm tall on this panel. robot.ui.showBalloon passes
 * its options object through to SpeechBalloon unfiltered, and SpeechBalloon accepts a font, so a
 * larger one should work - but that path is undocumented and unverified on the device.
 *
 * The danger is the failure mode, not the feature. Piu resolves fonts lazily: a name that does not
 * resolve throws from inside a layout pass, long after showBalloon returned and any try/catch around
 * it went out of scope. With no MOD frame on the stack that is an uncaught exception, which reboots
 * this device and leaves the screen dead until a person power-cycles it. A try/catch around the
 * showBalloon call cannot prevent that.
 *
 * So this module forces the lookup to happen synchronously, on our own stack, where a throw IS
 * catchable: Style.measure() resolves the font immediately. The answer is latched and reported in
 * get_robot_info, and nothing passes a font to a balloon until it has been read off a real robot.
 */

// The host image carries 16, 20 and 24; 12 is the balloon's own default and needs no probe.
const FONTS = { medium: 'OpenSans-Regular-20', large: 'OpenSans-Regular-24' }
const CANDIDATE = FONTS.medium

let probed = false
let available = false
let reason = 'not probed'
const resolved = {}

/** Runs the probe once. Safe to call at startup; never throws. */
export function probeBalloonFont() {
  if (probed) return available
  probed = true
  for (const size of Object.keys(FONTS)) {
    const font = FONTS[size]
    try {
      // measure() forces Piu's lazy font lookup here and now, rather than during a later layout pass.
      const style = new Style({ font })
      style.measure('x')
      resolved[size] = font
      if (font === CANDIDATE) {
        available = true
        reason = 'resolved'
      }
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
      if (font === CANDIDATE) {
        available = false
        reason = message
      }
      trace(`[font-probe] ${font}: unavailable (${message})\n`)
    }
  }
  trace(`[font-probe] ${CANDIDATE}: ${available ? 'available' : `unavailable (${reason})`}\n`)
  return available
}

export function describeBalloonFont() {
  if (!probed) return 'balloon font: not probed'
  return available ? `balloon font: ${CANDIDATE} available` : `balloon font: ${CANDIDATE} unavailable (${reason})`
}

export function balloonFontAvailable() {
  return available
}

export function balloonFontName() {
  return CANDIDATE
}

/**
 * The font to ask a balloon for at this size, or undefined to leave the balloon's own 12 px default
 * alone. Undefined is also the answer when the probe could not resolve it, so a host without these
 * fonts silently keeps working.
 */
export function fontForSize(size) {
  if (size === 'small') return undefined
  return resolved[size]
}
