/*
 * Custom face: the stock mouth ignores emotion, so HAPPY only squints the eyes. This draws a real
 * smile, and reports touches on the face area - the only route a MOD has to screen touches.
 *
 * Derived from stack-chan/stack-chan firmware/host/modules/ui/components/face/behaviors/face.ts and
 * parts/mouth.ts (v1.1.0), Apache License 2.0: it subclasses FaceBehavior, reuses the Eye part, and
 * keeps the upstream layout constants so the face lands in the same place. The new work is the mouth's
 * onDraw, which branches on Emotion.HAPPY, and the onTouch callback.
 */
import { FaceBehavior } from 'behaviors/face'
import { DEFAULT_FACE_PRIMARY_COLOR, Emotion, toPiuColorNumber, toPiuColorString } from 'face-state'
import { Eye } from 'parts/eye'
import Time from 'time'

// Layout matches host/modules/ui/components/face/behaviors/face.ts SimpleFace exactly, so this
// face looks and moves like the stock one unless noted otherwise.
const DEFAULT_FACE_LEFT = 60
const DEFAULT_FACE_TOP = 60
const DEFAULT_FACE_WIDTH = 200
const DEFAULT_FACE_HEIGHT = 120

// Same defaults as parts/mouth.ts's Mouth so the smile mouth occupies the same box and reacts to
// mouth-open the same way when it is not smiling.
const MOUTH_MIN_WIDTH = 50
const MOUTH_MAX_WIDTH = 90
const MOUTH_MIN_HEIGHT = 8
const MOUTH_MAX_HEIGHT = 58

const CLEAR_COLOR = 'transparent'
// Number of little bars used to approximate the smile arc. Kept small: this is redrawn on a
// timer on a 320x240 screen driven by an ESP32, so every extra fillColor call is real cost.
const SMILE_SEGMENTS = 9
const MIN_SMILE_THICKNESS = 3

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

let colorStringCache = null

function colorString(color) {
  if (!colorStringCache) colorStringCache = new Map()
  const cached = colorStringCache.get(color)
  if (cached) return cached
  const value = toPiuColorString(color)
  colorStringCache.set(color, value)
  return value
}

/** Same rectangle the default Mouth draws: used for every emotion except HAPPY. */
function drawDefaultMouthShape(port, color, w, h, maxWidth, maxHeight) {
  port.fillColor(color, Math.round((maxWidth - w) / 2), Math.round((maxHeight - h) / 2), Math.round(w), Math.round(h))
}

/**
 * Upward smile curve, built from a handful of stacked bars whose vertical offset follows a
 * downward parabola (deepest in the middle, rising to the corners) -- cheap to draw with the
 * same fillColor primitive the default mouth uses, no images/outlines/new assets involved.
 * The bounding box (left, top, w, h) exactly matches drawDefaultMouthShape's, so the smile
 * grows/shrinks with mouth.open the same way the default rectangle does.
 */
function drawSmileShape(port, color, w, h, maxWidth, maxHeight) {
  const left = (maxWidth - w) / 2
  const top = (maxHeight - h) / 2
  const thickness = Math.max(MIN_SMILE_THICKNESS, Math.min(h, Math.round(h / 3)))
  const amplitude = Math.max(0, h - thickness)
  let prevX = left
  for (let i = 0; i < SMILE_SEGMENTS; i++) {
    const nextX = left + (w * (i + 1)) / SMILE_SEGMENTS
    const segX = Math.round(prevX)
    const segW = Math.max(1, Math.round(nextX - prevX))
    // Sample at the segment midpoint; u runs from -1 (left corner) to +1 (right corner).
    const u = ((i + 0.5) / SMILE_SEGMENTS) * 2 - 1
    const yOffset = amplitude * (1 - u * u)
    const segY = Math.round(top + yOffset)
    port.fillColor(color, segX, segY, segW, thickness)
    prevX = nextX
  }
}

class SmileMouthBehavior extends Behavior {
  #minWidth = MOUTH_MIN_WIDTH
  #maxWidth = MOUTH_MAX_WIDTH
  #minHeight = MOUTH_MIN_HEIGHT
  #maxHeight = MOUTH_MAX_HEIGHT
  #open = 0
  #lastOpen = -1
  #emotion = Emotion.NEUTRAL
  #lastEmotion = null
  #primary = DEFAULT_FACE_PRIMARY_COLOR
  #hasPalette = false

  onCreate(port, opts) {
    try {
      this.#minWidth = opts.minWidth
      this.#maxWidth = opts.maxWidth
      this.#minHeight = opts.minHeight
      this.#maxHeight = opts.maxHeight
      port.invalidate()
    } catch (error) {
      trace(`[face-smile] mouth onCreate failed: ${errorMessage(error)}\n`)
    }
  }

  onFaceSkin(port, palette) {
    try {
      this.#hasPalette = true
      const nextPrimary = palette.primaryColor
      if (nextPrimary === this.#primary) return
      this.#primary = nextPrimary
      port.invalidate()
    } catch (error) {
      trace(`[face-smile] mouth onFaceSkin failed: ${errorMessage(error)}\n`)
    }
  }

  onFaceState(port, face) {
    try {
      const open = face.mouth.open
      const emotion = face.emotion
      let needsDraw = false
      if (!this.#hasPalette) {
        const nextPrimary = toPiuColorNumber(face.theme.primary)
        if (nextPrimary !== this.#primary) {
          this.#primary = nextPrimary
          needsDraw = true
        }
      }
      if (emotion !== this.#lastEmotion) needsDraw = true
      if (open === this.#lastOpen && !needsDraw) return
      this.#lastOpen = open
      this.#open = open
      this.#lastEmotion = emotion
      this.#emotion = emotion
      port.invalidate()
    } catch (error) {
      trace(`[face-smile] mouth onFaceState failed: ${errorMessage(error)}\n`)
    }
  }

  onDraw(port) {
    try {
      port.fillColor(CLEAR_COLOR, 0, 0, this.#maxWidth, this.#maxHeight)
      const h = this.#minHeight + (this.#maxHeight - this.#minHeight) * this.#open
      const w = this.#minWidth + (this.#maxWidth - this.#minWidth) * (1 - this.#open)
      const color = colorString(this.#primary)
      if (this.#emotion === Emotion.HAPPY) {
        drawSmileShape(port, color, w, h, this.#maxWidth, this.#maxHeight)
      } else {
        drawDefaultMouthShape(port, color, w, h, this.#maxWidth, this.#maxHeight)
      }
    } catch (error) {
      trace(`[face-smile] mouth onDraw failed: ${errorMessage(error)}\n`)
    }
  }
}

/** Drop-in replacement for parts/mouth.ts's Mouth: same options, same box, smile curve when HAPPY. */
const SmileMouth = Port.template((opts) => {
  const data = {
    cx: opts.cx,
    cy: opts.cy,
    minWidth: opts.minWidth ?? MOUTH_MIN_WIDTH,
    maxWidth: opts.maxWidth ?? MOUTH_MAX_WIDTH,
    minHeight: opts.minHeight ?? MOUTH_MIN_HEIGHT,
    maxHeight: opts.maxHeight ?? MOUTH_MAX_HEIGHT,
  }
  return {
    left: data.cx - data.maxWidth / 2,
    top: data.cy - data.maxHeight / 2,
    width: data.maxWidth,
    height: data.maxHeight,
    Behavior: class extends SmileMouthBehavior {
      onCreate(port) {
        super.onCreate(port, data)
      }
    },
  }
})

function safeInvoke(callback, event) {
  if (typeof callback !== 'function') return
  try {
    callback(event)
  } catch (error) {
    trace(`[face-smile] onTouch callback failed: ${errorMessage(error)}\n`)
  }
}

/** Piu's touch handlers pass ticks already; Time.ticks is only a fallback in case a host build doesn't. */
function resolveTicks(ticks) {
  if (typeof ticks === 'number') return ticks
  try {
    return Time.ticks
  } catch (error) {
    trace(`[face-smile] Time.ticks unavailable: ${errorMessage(error)}\n`)
    return 0
  }
}

/**
 * Same FaceBehavior host/modules/ui/components/face/behaviors/face.ts's SimpleFace uses (blink,
 * breath, saccade motions; theme distribution; the container.bubble('onFaceTouch') on touch end
 * that reveals the app bar / drawer -- see FaceBehavior.onTouchEnded, face.ts:144-146), plus an
 * optional options.onTouch callback fired on every phase.
 */
function createSmileFaceBehavior(onTouch) {
  return class extends FaceBehavior {
    constructor() {
      super({})
    }

    onTouchBegan(_container, id, x, y, ticks) {
      safeInvoke(onTouch, { kind: 'touch', phase: 'began', id, x, y, ticks: resolveTicks(ticks) })
    }

    onTouchMoved(_container, id, x, y, ticks) {
      safeInvoke(onTouch, { kind: 'touch', phase: 'moved', id, x, y, ticks: resolveTicks(ticks) })
    }

    onTouchEnded(container, id, x, y, ticks) {
      try {
        // Exactly what the default face does: bubble 'onFaceTouch' so the app bar / drawer
        // still reveal on touch. This must run whether or not options.onTouch is set or throws.
        super.onTouchEnded(container)
      } catch (error) {
        trace(`[face-smile] onFaceTouch bubble failed: ${errorMessage(error)}\n`)
      }
      safeInvoke(onTouch, { kind: 'touch', phase: 'ended', id, x, y, ticks: resolveTicks(ticks) })
    }
  }
}

/** Same shape as SimpleFace (host/modules/ui/components/face/behaviors/face.ts:267-283). */
const SmileFace = Container.template((data) => {
  const left = data.left ?? DEFAULT_FACE_LEFT
  const top = data.top ?? DEFAULT_FACE_TOP
  const width = data.width ?? DEFAULT_FACE_WIDTH
  const height = data.height ?? DEFAULT_FACE_HEIGHT
  return {
    left,
    top,
    width,
    height,
    active: true,
    contents: [
      new Eye({ cx: 30, cy: 33, radius: 8, side: 'left' }),
      new Eye({ cx: 170, cy: 36, radius: 8, side: 'right' }),
      new SmileMouth({ cx: 100, cy: 88 }),
    ],
    Behavior: createSmileFaceBehavior(data.onTouch),
  }
})

/**
 * Builds a new face container for robot.ui.setFace(...): behaves like the stock SimpleFace
 * (eyes, blinking, breathing, theme colors, all emotions, mouth-open / TTS lip sync) except the
 * mouth draws an upward smile curve while the emotion is HAPPY.
 *
 * @param {{ onTouch?: (event: { kind: 'touch', phase: 'began'|'moved'|'ended', id: number, x: number, y: number, ticks: number }) => void, left?: number, top?: number, width?: number, height?: number }} [options]
 */
export function createSmileFace(options = {}) {
  return new SmileFace({
    left: options.left,
    top: options.top,
    width: options.width,
    height: options.height,
    onTouch: options.onTouch,
  })
}
