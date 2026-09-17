/*
 * One place that owns the speech balloon.
 *
 * Two reasons it is not just robot.ui.showBalloon:
 *
 * 1. The host decides whether to reuse the existing balloon by comparing only its geometry - the
 *    font is not part of that comparison. So showing a balloon with a different font while one is
 *    already up silently keeps the old font, and the reverse leaks a large font into a caller that
 *    asked for none. Hiding first is the only way to change font reliably.
 * 2. Passing a font at all is undocumented: the host spreads the options object into its balloon
 *    without filtering, and its internal type happens to accept one. A font that does not resolve
 *    throws from inside a later layout pass, where nothing can catch it and the device reboots -
 *    hence font-probe.js, and hence asking it rather than naming a font here.
 */
import { fontForSize } from 'font-probe'

let currentFont

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

/** Shows text at a named size ('small' | 'medium' | 'large'). Returns the font actually used, if any. */
export function showBalloon(robot, text, size = 'medium') {
  const font = fontForSize(size)
  try {
    if (font !== currentFont) robot.ui.hideBalloon()
    robot.ui.showBalloon(text, font ? { font } : {})
    currentFont = font
  } catch (error) {
    // Never let a balloon take the robot down: fall back to the host's own default.
    trace(`[balloon] show failed (${errorMessage(error)}); retrying without a font\n`)
    try {
      robot.ui.showBalloon(text)
      currentFont = undefined
    } catch (retryError) {
      trace(`[balloon] show failed again: ${errorMessage(retryError)}\n`)
    }
  }
  return font
}

export function hideBalloon(robot) {
  try {
    robot.ui.hideBalloon()
  } catch (error) {
    trace(`[balloon] hide failed: ${errorMessage(error)}\n`)
  }
}
