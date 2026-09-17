/*
 * What the robot is currently doing, for get_robot_info to report.
 *
 * Why this exists: gaze tracking persists until look_away, torque stays held after a pose with
 * hold, and a speech balloon stays up until it is hidden or times out. None of that is visible to a
 * caller, so an assistant arriving mid-session - or after its own context was compacted - cannot
 * tell whether the robot is already holding a pose or showing a message, and the robot cannot see
 * its own screen to be asked.
 *
 * Deliberately not tracked: the LED ring. indicators.js sets and clears it around every capture, so
 * a shadowed value here would be stale exactly when someone was reading it to understand a capture.
 * A wrong answer is worse than no answer.
 */

const state = {
  gaze: null, // the point being tracked, or null
  torque: false,
  screen: 'face', // 'face', or a short description of what replaced or covers it
}

export function noteGaze(point) {
  state.gaze = point
}

export function noteTorque(held) {
  state.torque = held === true
}

export function noteScreen(what) {
  state.screen = typeof what === 'string' && what.length > 0 ? what : 'face'
}

/** One line for get_robot_info. Kept short: it is part of a response with a hard size budget. */
export function describeState() {
  const parts = []
  parts.push(state.gaze ? `gaze tracking [${state.gaze}]` : 'no gaze tracking')
  parts.push(state.torque ? 'torque held' : 'torque released')
  parts.push(`screen: ${state.screen}`)
  return parts.join(', ')
}
