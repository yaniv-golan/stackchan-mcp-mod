import { base64Length } from 'base64'
import config from 'mc/config'
import { createPhotoView } from 'photo-view'
import { encodeRGB565AsPNG, estimatePNGSize } from 'png'
import { showContent } from 'screen'
import Timer from 'timer'

// The GC0308 sensor has no JPEG mode, so frames come back as RGB565 and are encoded here.
// Bigger modes need more contiguous DMA; the host's own preview sticks to the sensor's native QQVGA.
// One size, because one size fits. 176x144 encodes to ~35 KB on the wire and 240x176 to ~57.5 KB against
// the 28 KB budget below, in colour and grayscale alike - they were offered in the schema and refused
// twenty lines later, so a model spent a call finding out. The budget check stays as the backstop: it is
// what decides, and it must keep deciding if this ever grows.
const SIZES = {
  '160x120': { width: 160, height: 120 },
}
const DEFAULT_SIZE = '160x120'
const STOP_DELAY_MS = 120
// Measured on the device: bodies up to ~27.8 KB (a 160x120 color photo) are served repeatably, while
// ~57 KB never finishes and takes the HTTP server down with it. The threshold between those two is
// unmeasured, so the budget sits just above the largest size known to work. The budget is on the BODY, which carries base64 (4 bytes per 3) plus a JSON envelope -
// capping raw PNG bytes instead would let a 20 KB image become a 27 KB body.
const MAX_BODY_BYTES = 28000
const ENVELOPE_ALLOWANCE = 900
// screen.showContent clamps to [1000, 120000]; ten seconds is enough to look at a photo without
// leaving the face off for long, matching what the tool description promises callers.
const SHOW_ON_SCREEN_HOLD_MS = 10000

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

  const capture = async (size, mode, showOnScreen) => {
    const request = { width: size.width, height: size.height, imageType: imageType() }
    let frame
    try {
      await settle(camera.start(request))
      frame = await camera.capture(request)
      if (!frame) throw new Error('camera returned no frame')
      const { width, height, imageType: frameImageType } = frame
      const bigEndian = frameImageType === 'rgb565be'

      if (!showOnScreen) {
        // Unchanged from before show_on_screen existed: encode straight from the frame's own buffer,
        // close it in the finally block below.
        const png = encodeRGB565AsPNG(frame.buffer, { width, height, mode, bigEndian })
        return { png, width, height, view: undefined }
      }

      // With show_on_screen, three things would otherwise be alive together: the 38,400-byte frame,
      // the photo view's own ~48,000-byte copy, and the ~20 KB PNG - and this device's blank screens
      // correlate with memory pressure (docs/device-notes.md). So take a plain copy of the raw pixels
      // and release the frame - a disposable, DMA-backed buffer - right away, before building the view
      // or encoding, rather than holding it until the finally block. This also ends the camera's own
      // claim on that memory before the display starts blitting from the copy, which is the pairing
      // the camera DMA sdkconfig note warns about (PSRAM transfers competing with the display).
      const rawPixels = new Uint8Array(frame.buffer).slice()
      try {
        frame.close?.()
      } catch (error) {
        trace(`[mcp-mod] camera frame close failed: ${errorMessage(error)}\n`)
      }
      frame = undefined

      let view
      try {
        view = createPhotoView({ width, height, imageType: frameImageType, buffer: rawPixels.buffer })
      } catch (error) {
        // Screen display is a bonus, not the tool's job: still return the photo the caller asked for.
        trace(`[mcp-mod] photo view unavailable: ${errorMessage(error)}\n`)
        view = undefined
      }

      const png = encodeRGB565AsPNG(rawPixels, { width, height, mode, bigEndian })
      return { png, width, height, view }
    } finally {
      // Idempotent (camera.ts guards it with its own isClosed flag), so calling it again here when
      // show_on_screen already closed it above is harmless - and it must still run on every path,
      // including a throw from encoding.
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
      name: 'camera_take_photo',
      description:
        'Take a photo with the head camera and return it as a PNG image. Capturing pauses the head touch strip for a moment. 160x120 is the only size this robot can send. Color uses a 256-color palette, the same pixel size as grayscale, but at ~27.8 KB on the wire it sits just under what the device can transmit, so prefer grayscale unless color is the point.',
      inputSchema: {
        type: 'object',
        properties: {
          size: {
            type: 'string',
            enum: Object.keys(SIZES),
            description: `Capture size. ${DEFAULT_SIZE} is the only value this robot can send.`,
          },
          color: { type: 'boolean', description: 'Return a 256-color palette PNG instead of the default grayscale' },
          show_on_screen: {
            type: 'boolean',
            description:
              "Also display the captured photo on the robot's own screen, in place of the face, for about ten seconds before the face returns. Default false. If the screen cannot show a real picture right now, it falls back to a coarse color mosaic instead - the result text says which one happened.",
          },
        },
      },
      handler: async (args) => {
        const key = args.size === undefined ? DEFAULT_SIZE : args.size
        const size = SIZES[key]
        if (!size) throw new Error(`size must be one of ${Object.keys(SIZES).join(', ')}`)
        const mode = args.color === true ? 'palette' : 'gray'
        const showOnScreen = args.show_on_screen === true
        const estimate = estimatePNGSize(size.width, size.height, mode)
        const bodyEstimate = base64Length(estimate) + ENVELOPE_ALLOWANCE
        if (bodyEstimate > MAX_BODY_BYTES) {
          throw new Error(
            `${key} ${mode === 'palette' ? 'color' : 'grayscale'} would be about ${estimate} bytes of PNG, roughly ${bodyEstimate} bytes on the wire once base64-encoded, over the ${MAX_BODY_BYTES} byte response limit this robot can send; use ${DEFAULT_SIZE} grayscale`,
          )
        }
        policy?.check('camera_take_photo')
        if (busy) throw new Error('camera is busy with another capture')
        busy = true
        try {
          const { png, width, height, view } = indicators
            ? await indicators.camera(() => capture(size, mode, showOnScreen))
            : await capture(size, mode, showOnScreen)

          let screenNote = ''
          if (showOnScreen) {
            if (view?.content) {
              try {
                showContent(robot, 'photo', view.content, SHOW_ON_SCREEN_HOLD_MS)
                screenNote =
                  view.mode === 'bitmap'
                    ? ' Shown on screen for about 10 seconds.'
                    : ' Shown on screen for about 10 seconds as a coarse 15-block color mosaic, not a real picture - the bitmap preview was unavailable.'
              } catch (error) {
                screenNote = ` Could not show it on screen: ${errorMessage(error)}`
              }
            } else {
              screenNote = ' Could not show it on screen: the preview view failed to build.'
            }
          }

          return {
            content: [
              // dataBytes (not data): the server base64-encodes this straight into the response buffer.
              { type: 'image', dataBytes: png, mimeType: 'image/png' },
              {
                type: 'text',
                text: `Photo: ${width}x${height} ${mode === 'palette' ? '256-color' : 'grayscale'} PNG, ${png.length} bytes.${screenNote}`,
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
