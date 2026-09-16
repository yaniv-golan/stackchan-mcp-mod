/*
 * Motion tools for stackchan-mcp-mod: expose the head-pose and gaze API (robot.motion.*) as MCP tools.
 */
import Timer from 'timer'

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

const YAW_MIN_DEGREES = -128
const YAW_MAX_DEGREES = 128
const PITCH_MIN_DEGREES = -90
const PITCH_MAX_DEGREES = 0
const DURATION_MIN_SECONDS = 0.1
const DURATION_MAX_SECONDS = 5
const LOOK_AT_MIN_METERS = -5
const LOOK_AT_MAX_METERS = 5

// setPose resolves when the head STARTS moving, so torque has to stay on for the whole move.
const TORQUE_RELEASE_MARGIN_MS = 150

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function wait(milliseconds) {
  return new Promise((resolve) => Timer.set(resolve, milliseconds))
}

function requireFiniteAxis(args, name) {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} is required and must be a number`)
  return value
}

export function motionTools(robot) {
  return [
    {
      name: 'set_head_pose',
      description:
        'Move the robot head to an absolute yaw/pitch pose. yaw_degrees is clamped to -128..128 (positive is the ' +
        "robot's left), pitch_degrees is clamped to -90..0 (negative looks up, 0 is level). duration_seconds " +
        '(default 0.5) is clamped to 0.1..5. Torque is enabled for the move and released afterward unless hold ' +
        'is true.',
      inputSchema: {
        type: 'object',
        properties: {
          yaw_degrees: { type: 'number', description: "Head yaw in degrees, -128..128, positive is the robot's left" },
          pitch_degrees: { type: 'number', description: 'Head pitch in degrees, -90 (up) to 0 (level)' },
          duration_seconds: {
            type: 'number',
            description: 'Move duration in seconds, 0.1..5 (default 0.5)',
          },
          hold: {
            type: 'boolean',
            description: 'Keep torque engaged after the move so the pose is held (default false)',
          },
        },
        required: ['yaw_degrees', 'pitch_degrees'],
      },
      handler: async (args) => {
        const yawInput = requireFiniteAxis(args, 'yaw_degrees')
        const pitchInput = requireFiniteAxis(args, 'pitch_degrees')
        const durationInput = args.duration_seconds === undefined ? 0.5 : args.duration_seconds
        if (typeof durationInput !== 'number' || !Number.isFinite(durationInput)) {
          throw new Error('duration_seconds must be a number')
        }
        const hold = args.hold === undefined ? false : args.hold
        if (typeof hold !== 'boolean') throw new Error('hold must be a boolean')

        const yawDegrees = clamp(yawInput, YAW_MIN_DEGREES, YAW_MAX_DEGREES)
        const pitchDegrees = clamp(pitchInput, PITCH_MIN_DEGREES, PITCH_MAX_DEGREES)
        const durationSeconds = clamp(durationInput, DURATION_MIN_SECONDS, DURATION_MAX_SECONDS)

        const clampedNotes = []
        if (yawDegrees !== yawInput) clampedNotes.push('yaw_degrees')
        if (pitchDegrees !== pitchInput) clampedNotes.push('pitch_degrees')
        if (durationSeconds !== durationInput) clampedNotes.push('duration_seconds')

        await robot.motion.setTorque(true)
        try {
          await robot.motion.setPose(
            {
              position: { ...robot.motion.pose.body.position },
              rotation: { y: yawDegrees * DEG_TO_RAD, p: pitchDegrees * DEG_TO_RAD, r: 0 },
            },
            durationSeconds,
          )
          // setPose returns once the move has been commanded; wait it out so the head arrives.
          await wait(durationSeconds * 1000 + TORQUE_RELEASE_MARGIN_MS)
        } finally {
          if (!hold) await robot.motion.setTorque(false)
        }

        const clampedSuffix = clampedNotes.length > 0 ? ` (clamped: ${clampedNotes.join(', ')})` : ''
        return (
          `Head pose set to yaw=${yawDegrees.toFixed(1)}deg, pitch=${pitchDegrees.toFixed(1)}deg, ` +
          `duration=${durationSeconds.toFixed(2)}s${clampedSuffix}. Torque is ${hold ? 'held' : 'released'}.`
        )
      },
    },
    {
      name: 'look_at',
      description:
        "Start gaze tracking at a 3D point in meters, right-handed body frame: +x forward, +y is the robot's " +
        'left, +z up. Each coordinate is clamped to -5..5. The head continues tracking this point until look_away ' +
        'is called or a new look_at replaces it.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Forward distance in meters, clamped to -5..5' },
          y: {
            type: 'number',
            description: "Left/right distance in meters (positive is the robot's left), clamped to -5..5",
          },
          z: { type: 'number', description: 'Up/down distance in meters, clamped to -5..5' },
        },
        required: ['x', 'y', 'z'],
      },
      handler: (args) => {
        const x = requireFiniteAxis(args, 'x')
        const y = requireFiniteAxis(args, 'y')
        const z = requireFiniteAxis(args, 'z')
        const clampedX = clamp(x, LOOK_AT_MIN_METERS, LOOK_AT_MAX_METERS)
        const clampedY = clamp(y, LOOK_AT_MIN_METERS, LOOK_AT_MAX_METERS)
        const clampedZ = clamp(z, LOOK_AT_MIN_METERS, LOOK_AT_MAX_METERS)
        robot.motion.lookAt([clampedX, clampedY, clampedZ])
        return `Gaze tracking is now active toward [${clampedX.toFixed(2)}, ${clampedY.toFixed(2)}, ${clampedZ.toFixed(2)}] meters. Call look_away to stop.`
      },
    },
    {
      name: 'look_away',
      description: 'Stop gaze tracking started by look_at and leave the head at its current pose.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        robot.motion.lookAway()
        return 'Gaze tracking stopped.'
      },
    },
    {
      name: 'get_head_pose',
      description:
        'Read the last known head pose (yaw/pitch/roll and position). Caveat: this is a cached value that is ' +
        'only refreshed while the motion controller is polling, which only happens during an active look_at gaze ' +
        'or while a motion is in progress, so the value can be stale otherwise.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        const rotation = robot.motion.pose.body.rotation
        const position = robot.motion.pose.body.position
        const yawDeg = rotation.y * RAD_TO_DEG
        const pitchDeg = rotation.p * RAD_TO_DEG
        const rollDeg = rotation.r * RAD_TO_DEG
        return `Head pose (may be stale unless gaze tracking or a motion is active): yaw=${yawDeg.toFixed(1)}deg (${rotation.y.toFixed(3)}rad), pitch=${pitchDeg.toFixed(1)}deg (${rotation.p.toFixed(3)}rad), roll=${rollDeg.toFixed(1)}deg (${rotation.r.toFixed(3)}rad); position=[${position.x.toFixed(3)}, ${position.y.toFixed(3)}, ${position.z.toFixed(3)}]`
      },
    },
    {
      name: 'set_torque',
      description:
        'Enable or disable servo torque on the head. With torque off, the head can be moved by hand and will not ' +
        'hold its position; with torque on, the head resists being moved and holds the last commanded pose.',
      inputSchema: {
        type: 'object',
        properties: { enabled: { type: 'boolean', description: 'true to enable torque, false to release it' } },
        required: ['enabled'],
      },
      handler: async (args) => {
        if (typeof args.enabled !== 'boolean') throw new Error('enabled is required and must be a boolean')
        await robot.motion.setTorque(args.enabled)
        return `Torque ${args.enabled ? 'enabled' : 'disabled'}.`
      },
    },
  ]
}

export default motionTools
