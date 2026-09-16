import { base64Length } from 'base64'
import config from 'mc/config'
import { encodeRGB565AsPNG, estimatePNGSize } from 'png'
import Timer from 'timer'

// The GC0308 sensor has no JPEG mode, so frames come back as RGB565 and are encoded here.
// Bigger modes need more contiguous DMA; the host's own preview sticks to the sensor's native QQVGA.
const SIZES = {
  '160x120': { width: 160, height: 120 },
  '176x144': { width: 176, height: 144 },
  '240x176': { width: 240, height: 176 },
}
const DEFAULT_SIZE = '160x120'
const STOP_DELAY_MS = 120
// Measured on the device: bodies up to ~27.8 KB (a 160x120 color photo) are served repeatably, while
// ~57 KB never finishes and takes the HTTP server down with it. The threshold between those two is
// unmeasured, so the budget sits just above the largest size known to work. The budget is on the BODY, which carries base64 (4 bytes per 3) plus a JSON envelope -
// capping raw PNG bytes instead would let a 20 KB image become a 27 KB body.
const MAX_BODY_BYTES = 28000
const ENVELOPE_ALLOWANCE = 900

function imageType() {
  return config.format === 'RGB565BE' ? 'rgb565be' : 'rgb565le'
}

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function settle(result) {
  return result && typeof result.then === 'function' ? result : Promise.resolve(result)
}

/** The host stops the camera a beat after use; doing it immediately can trip over an in-flight frame. */
function stopAfterDelay(camera) {
  return new Promise((resolve) => {
    Timer.set(() => {
      settle(camera.stop()).then(resolve, (error) => {
        trace(`[mcp-mod] camera stop failed: ${errorMessage(error)}\n`)
        resolve()
      })
    }, STOP_DELAY_MS)
  })
}

export function cameraTools(robot, { policy, indicators } = {}) {
  const camera = robot.camera
  if (!camera || camera.available === false) return []
  // `off` means the tool is never registered, so a client cannot learn the camera exists.
  if (policy && !policy.enabled) return []

  let busy = false

  const capture = async (size, mode) => {
    const request = { width: size.width, height: size.height, imageType: imageType() }
    let frame
    try {
      await settle(camera.start(request))
      frame = await camera.capture(request)
      if (!frame) throw new Error('camera returned no frame')
      const png = encodeRGB565AsPNG(frame.buffer, {
        width: frame.width,
        height: frame.height,
        mode,
        bigEndian: frame.imageType === 'rgb565be',
      })
      return { png, width: frame.width, height: frame.height }
    } finally {
      // The frame buffer is disposable: release it before stopping, and stop even if encoding failed.
      try {
        frame?.close?.()
      } catch (error) {
        trace(`[mcp-mod] camera frame close failed: ${errorMessage(error)}\n`)
      }
      await stopAfterDelay(camera)
    }
  }

  return [
    {
      name: 'take_photo',
      description:
        'Take a photo with the head camera and return it as a PNG image. Capturing pauses the head touch strip for a moment. Color uses a 256-color palette, the same size as grayscale; the robot cannot send a larger image than about 24 KB, so bigger sizes are refused.',
      inputSchema: {
        type: 'object',
        properties: {
          size: {
            type: 'string',
            enum: Object.keys(SIZES),
            description: `Capture size, default ${DEFAULT_SIZE}. Larger sizes need more memory and may fail.`,
          },
          color: { type: 'boolean', description: 'Return a 256-color palette PNG instead of the default grayscale' },
        },
      },
      handler: async (args) => {
        const key = args.size === undefined ? DEFAULT_SIZE : args.size
        const size = SIZES[key]
        if (!size) throw new Error(`size must be one of ${Object.keys(SIZES).join(', ')}`)
        const mode = args.color === true ? 'palette' : 'gray'
        const estimate = estimatePNGSize(size.width, size.height, mode)
        const bodyEstimate = base64Length(estimate) + ENVELOPE_ALLOWANCE
        if (bodyEstimate > MAX_BODY_BYTES) {
          throw new Error(
            `${key} ${mode === 'palette' ? 'color' : 'grayscale'} would be about ${estimate} bytes of PNG, roughly ${bodyEstimate} bytes on the wire once base64-encoded, over the ${MAX_BODY_BYTES} byte response limit this robot can send; use ${DEFAULT_SIZE} grayscale`,
          )
        }
        policy?.check('take_photo')
        if (busy) throw new Error('camera is busy with another capture')
        busy = true
        try {
          const { png, width, height } = indicators
            ? await indicators.camera(() => capture(size, mode))
            : await capture(size, mode)
          return {
            content: [
              // dataBytes (not data): the server base64-encodes this straight into the response buffer.
              { type: 'image', dataBytes: png, mimeType: 'image/png' },
              {
                type: 'text',
                text: `Photo: ${width}x${height} ${mode === 'palette' ? '256-color' : 'grayscale'} PNG, ${png.length} bytes.`,
              },
            ],
          }
        } finally {
          busy = false
        }
      },
    },
  ]
}

export default cameraTools
