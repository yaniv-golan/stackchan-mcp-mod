import { noteScreen } from 'robot-state'
/*
 * One owner for the 320x240 screen.
 *
 * The face, a speech balloon, a photo and a QR code all want the same panel, and the host's own
 * petting reaction swaps the face without asking. Without a single place that knows what is
 * displayed and what puts the face back, these tools quietly fight: two of them set a hide timer,
 * the first one fires and restores the face under the second, and get_robot_info reports whichever
 * one wrote last.
 *
 * So everything that replaces the face goes through here. Balloons are separate (balloon.js): they
 * are drawn *over* whatever is displayed rather than replacing it.
 */
import Timer from 'timer'

const MAX_HOLD_MS = 120000

let hideTimer
let current = 'face'

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function clearHideTimer() {
  if (hideTimer === undefined) return
  try {
    Timer.clear(hideTimer)
  } catch (error) {
    trace(`[screen] clearing the hide timer failed: ${errorMessage(error)}\n`)
  }
  hideTimer = undefined
}

/** Puts the face back. Safe to call when the face is already showing. */
export function showFace(robot) {
  clearHideTimer()
  try {
    robot.ui.showFace()
  } catch (error) {
    trace(`[screen] showFace failed: ${errorMessage(error)}\n`)
  }
  current = 'face'
  noteScreen('face')
}

/**
 * Shows a Piu container in place of the face, and restores the face after hideAfterMs.
 *
 * The timer is not optional: something that replaces the face and has no way back leaves the robot
 * expressionless until the next tool call, and the person in front of it has no idea why.
 */
export function showContent(robot, label, content, hideAfterMs) {
  clearHideTimer()
  const hold = Math.max(1000, Math.min(MAX_HOLD_MS, hideAfterMs))
  try {
    robot.ui.setMain(content)
  } catch (error) {
    trace(`[screen] setMain failed: ${errorMessage(error)}\n`)
    showFace(robot)
    throw new Error(`the screen could not show ${label}: ${errorMessage(error)}`)
  }
  current = label
  noteScreen(label)
  hideTimer = Timer.set(() => {
    hideTimer = undefined
    showFace(robot)
  }, hold)
  return hold
}

/** What is on the screen now, for get_robot_info. */
export function describeScreen() {
  return current
}
