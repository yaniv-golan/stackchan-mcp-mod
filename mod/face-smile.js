import { FaceBehavior } from 'behaviors/face'
/*
 * Custom face: a vector mouth and eyebrows that react to every emotion, plus the only route a MOD
 * has to screen touches.
 *
 * Why it exists. The stock face leaves five of the eight emotions without a mouth and three of them
 * (DOUBTFUL, COLD, HOT) without any visual change at all - they render exactly like NEUTRAL. This
 * face gives each emotion its own mouth and a pair of eyebrows, which do more for a perceived
 * expression than anything else on a face this small.
 *
 * Derived from stack-chan/stack-chan firmware v1.1.0 (Apache License 2.0):
 * - host/modules/ui/components/face/behaviors/face.ts - SimpleFace's layout and FaceBehavior
 * - host/modules/ui/components/face/parts/mouth.ts - the mouth's box and its open/close geometry
 * - host/modules/ui/components/face/parts/dog/{mouth,eyebrow}.ts - the cached-Outline Shape pattern
 *
 * Two constraints shape the code and are not negotiable:
 *
 * 1. Building an Outline allocates, and allocating on the render tick is what the firmware's own
 *    architecture tests forbid. So every outline is built once, keyed on *quantized* state, and
 *    cached; the tick path only compares integers and assigns a cached reference.
 * 2. Nothing may throw out of a Piu callback. An uncaught exception reboots the device, and a reboot
 *    on this hardware leaves the screen dead until a human power-cycles it.
 */
import { Outline } from 'commodetto/outline'
import { DEFAULT_FACE_PRIMARY_COLOR, Emotion, toPiuColorNumber } from 'face-state'
import { Eye } from 'parts/eye'
import { getFillStrokeSkin, quantizeUnit, rememberCachedValue, unitFromStep } from 'parts/shape-utils'
import Time from 'time'

// Layout matches host/modules/ui/components/face/behaviors/face.ts SimpleFace exactly, so this face
// sits where the stock one does.
const DEFAULT_FACE_LEFT = 60
const DEFAULT_FACE_TOP = 60
const DEFAULT_FACE_WIDTH = 200
const DEFAULT_FACE_HEIGHT = 120

// Same box and open/close behaviour as parts/mouth.ts: opening makes the mouth taller and narrower.
const MOUTH_CX = 100
const MOUTH_CY = 88
const MOUTH_MIN_WIDTH = 50
const MOUTH_MAX_WIDTH = 90
const MOUTH_MIN_HEIGHT = 8
const MOUTH_MAX_HEIGHT = 58

const EYE_LEFT_CX = 30
const EYE_RIGHT_CX = 170
const EYEBROW_CY = 14
const EYEBROW_RADIUS_X = 13
const EYEBROW_RADIUS_Y = 4

const FULL_TURN = 2 * Math.PI
const MIN_STROKE = 3
// How far the centre of a line-shaped mouth bows, in pixels. Constant on purpose: deriving it from
// the mouth's open height made a smile sag deeper as the robot spoke, which read as wrong even
// though the lip sync was working.
const MOUTH_BOW = 15
// Above this openness a line-shaped mouth stops being a line and becomes a filled lens - an open
// mouth that keeps the emotion's curvature in its top and bottom lip, which is what an open smile
// actually looks like.
const OPEN_MOUTH_THRESHOLD = 0.18

// Intensity is ours: FaceState.emotion is a bare enum with no magnitude, so "mildly doubtful" and
// "furious" would otherwise look identical. Three buckets, because every extra bucket multiplies the
// number of distinct outlines that have to be built and held.
const INTENSITY_BUCKETS = 2 // Math.round(value * 2) gives 0, 1 or 2
const DEFAULT_INTENSITY = 0.7

// Cache ceilings, passed explicitly rather than taking the firmware's 128 default. A session
// normally touches one or two emotions across all 13 openness steps, so these are generous; they
// exist to bound memory if something cycles emotions, not because the key space is large.
const MOUTH_CACHE_LIMIT = 96
const EYEBROW_CACHE_LIMIT = 48

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function quantizeIntensity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return Math.round(DEFAULT_INTENSITY * INTENSITY_BUCKETS)
  const clamped = Math.max(0, Math.min(1, value))
  return Math.round(clamped * INTENSITY_BUCKETS)
}

let intensityStep = quantizeIntensity(DEFAULT_INTENSITY)

/**
 * Sets how strongly the current emotion is expressed, 0..1. Returns the quantized value applied.
 *
 * It only stores the value: the parts read it in their next onFaceState, which the breath and blink
 * motions trigger continuously, so a change appears within a frame or two.
 *
 * An earlier version kept a list of callbacks holding Shape references and invoked them here, to
 * repaint immediately. That is a dangling-reference waiting to happen: the host swaps the face out
 * from under this MOD - its own petting reaction does exactly that - and a stored Shape then points
 * at a destroyed Piu object. Reaching into one from outside a Piu callback is a fault rather than a
 * catchable exception, which on this device means a reboot and a screen someone has to walk over and
 * revive. A frame of latency is a good trade for holding no references at all.
 */
export function setEmotionIntensity(value) {
  intensityStep = quantizeIntensity(value)
  return intensityStep / INTENSITY_BUCKETS
}

/** The intensity currently applied, 0..1, for reporting in get_robot_info. */
export function getEmotionIntensity() {
  return intensityStep / INTENSITY_BUCKETS
}

/**
 * The applied intensity as a word. Reporting the number instead reads like a bug: ask for 0.7 and
 * the quantized answer is 0.5, which looks as though the argument was ignored rather than bucketed.
 */
export function describeEmotionIntensity() {
  if (intensityStep <= 0) return 'subtle'
  if (intensityStep >= INTENSITY_BUCKETS) return 'strong'
  return 'normal'
}

/** How much a line-shaped mouth bows, and which way. Positive curves down, into a smile. */
function mouthBow(emotion) {
  switch (emotion) {
    case Emotion.HAPPY:
      return 1
    case Emotion.SAD:
      return -1
    case Emotion.ANGRY:
      return -0.9
    case Emotion.DOUBTFUL:
      return 0.5
    default:
      return 0
  }
}

/** Emotions drawn as a line while the mouth is closed; the rest are always filled. */
function isLineMouth(emotion) {
  return (
    emotion === Emotion.HAPPY ||
    emotion === Emotion.SAD ||
    emotion === Emotion.ANGRY ||
    emotion === Emotion.DOUBTFUL ||
    emotion === Emotion.COLD
  )
}

/** Whether this state is drawn as a filled shape. Pure, so the cache can stay outlines-only. */
function isFilledMouth(emotion, openStep) {
  if (!isLineMouth(emotion)) return true
  return unitFromStep(openStep) > OPEN_MOUTH_THRESHOLD
}

/**
 * One mouth path per emotion, in face-local coordinates. `open` (0..1) is the lip-sync channel and
 * must keep working for every emotion: it grows the opening the way the stock mouth does. `weight`
 * (0..1) is the emotion's intensity.
 */
function buildMouthPath(emotion, open, weight) {
  const h = MOUTH_MIN_HEIGHT + (MOUTH_MAX_HEIGHT - MOUTH_MIN_HEIGHT) * open
  const w = MOUTH_MIN_WIDTH + (MOUTH_MAX_WIDTH - MOUTH_MIN_WIDTH) * (1 - open)
  const left = MOUTH_CX - w / 2
  const right = MOUTH_CX + w / 2
  const path = new Outline.CanvasPath()
  // 0.3 at subtle, 1.0 at strong. A narrower range than this is invisible on a 200 px face: the
  // first attempt moved ANGRY's mouth by 2.6 px between the extremes and nobody could see it.
  const bend = 0.3 + 0.7 * weight

  if (isLineMouth(emotion)) {
    const bow = MOUTH_BOW * mouthBow(emotion) * bend
    if (isFilledMouth(emotion, quantizeUnit(open))) {
      // Open: a lens between two lips. The top lip carries the emotion's curve, the bottom one the
      // same curve pushed down by however far the mouth is open, so the shape opens without
      // straightening or sagging.
      const lip = MOUTH_CY - h * 0.15
      path.moveTo(left, lip)
      path.quadraticCurveTo(MOUTH_CX, lip + bow * 2, right, lip)
      path.quadraticCurveTo(MOUTH_CX, lip + bow * 2 + h * 1.6, left, lip)
      path.closePath()
      return path
    }
    if (emotion === Emotion.COLD) {
      // A shiver: a small wave across the mouth's width.
      const segments = 4
      const amplitude = Math.max(2, MOUTH_BOW * 0.35 * bend)
      path.moveTo(left, MOUTH_CY)
      for (let i = 1; i <= segments; i++) {
        const x = left + (w * i) / segments
        const controlX = left + (w * (i - 0.5)) / segments
        const controlY = MOUTH_CY + (i % 2 === 0 ? amplitude : -amplitude)
        path.quadraticCurveTo(controlX, controlY, x, MOUTH_CY)
      }
      return path
    }
    if (emotion === Emotion.DOUBTFUL) {
      // A smirk: one corner up, the other down.
      path.moveTo(left, MOUTH_CY + bow * 0.6)
      path.quadraticCurveTo(MOUTH_CX - w * 0.25, MOUTH_CY + bow, MOUTH_CX, MOUTH_CY)
      path.quadraticCurveTo(MOUTH_CX + w * 0.25, MOUTH_CY - bow, right, MOUTH_CY - bow * 0.6)
      return path
    }
    // HAPPY, SAD and ANGRY closed: one arc, bowing by a constant amount.
    path.moveTo(left, MOUTH_CY - bow * 0.5)
    path.quadraticCurveTo(MOUTH_CX, MOUTH_CY + bow * 1.5, right, MOUTH_CY - bow * 0.5)
    return path
  }

  switch (emotion) {
    case Emotion.SLEEPY:
      // Small and relaxed, barely open however much the lip sync asks for.
      path.ellipse(MOUTH_CX, MOUTH_CY, Math.max(6, w * 0.18), Math.max(2, h * 0.22), 0, 0, FULL_TURN)
      break
    case Emotion.HOT:
      // Panting: wide and open, widening with intensity.
      path.ellipse(
        MOUTH_CX,
        MOUTH_CY + h * 0.1,
        Math.max(10, w * (0.3 + 0.12 * weight)),
        Math.max(4, h * (0.4 + 0.15 * weight)),
        0,
        0,
        FULL_TURN,
      )
      break
    default:
      // NEUTRAL, and anything a future firmware adds: the stock bar.
      path.rect(left, MOUTH_CY - h / 2, w, h)
      break
  }
  return path
}

let mouthOutlineCache = null

function getMouthOutline(emotion, openStep, weightStep) {
  if (!mouthOutlineCache) mouthOutlineCache = new Map()
  const key = `${emotion}:${openStep}:${weightStep}`
  const cached = mouthOutlineCache.get(key)
  if (cached) return cached

  const open = unitFromStep(openStep)
  const weight = weightStep / INTENSITY_BUCKETS
  const path = buildMouthPath(emotion, open, weight)
  const outline = isFilledMouth(emotion, openStep)
    ? Outline.fill(path)
    : Outline.stroke(path, Math.max(MIN_STROKE, Math.round(3 + 4 * (weightStep / INTENSITY_BUCKETS))))
  return rememberCachedValue(mouthOutlineCache, key, outline, MOUTH_CACHE_LIMIT)
}

/** Rotation of one eyebrow, as a multiple of the base tilt. Positive pulls the inner end down. */
function eyebrowTilt(emotion, side) {
  const inner = side === 'left' ? 1 : -1
  switch (emotion) {
    case Emotion.ANGRY:
      return 1.2 * inner
    case Emotion.SAD:
      return -1 * inner
    case Emotion.HAPPY:
      return 0.4 * inner
    case Emotion.SLEEPY:
      return 0.15 * inner
    case Emotion.DOUBTFUL:
      // Asymmetric on purpose: one brow raised is what makes a face look sceptical.
      return side === 'left' ? 1 : -0.3
    case Emotion.COLD:
      return 0.5 * inner
    case Emotion.HOT:
      return -0.25 * inner
    default:
      return 0.15 * inner
  }
}

/** Vertical offset of one eyebrow: negative is raised. */
function eyebrowLift(emotion) {
  switch (emotion) {
    case Emotion.HAPPY:
      return -3
    case Emotion.DOUBTFUL:
      return -4
    case Emotion.SAD:
      return -1
    case Emotion.SLEEPY:
      return 3
    case Emotion.ANGRY:
      return 2
    default:
      return 0
  }
}

let eyebrowOutlineCache = null

function getEyebrowOutline(side, emotion, weightStep) {
  if (!eyebrowOutlineCache) eyebrowOutlineCache = new Map()
  const key = `${side}:${emotion}:${weightStep}`
  const cached = eyebrowOutlineCache.get(key)
  if (cached) return cached

  const weight = weightStep / INTENSITY_BUCKETS
  const scale = 0.25 + 0.75 * weight
  const cx = side === 'left' ? EYE_LEFT_CX : EYE_RIGHT_CX
  const cy = EYEBROW_CY + eyebrowLift(emotion) * scale
  const rotation = (Math.PI / 7) * eyebrowTilt(emotion, side) * scale
  const path = new Outline.CanvasPath()
  // A strong feeling also thickens the brow: angle alone reads as a tilt, weight reads as a scowl.
  const radiusY = EYEBROW_RADIUS_Y * (0.8 + 0.5 * weight)
  path.ellipse(cx, cy, EYEBROW_RADIUS_X, radiusY, rotation, 0, FULL_TURN)
  const outline = Outline.fill(path)
  return rememberCachedValue(eyebrowOutlineCache, key, outline, EYEBROW_CACHE_LIMIT)
}

/**
 * Shared skin handling: a part follows the face palette when one arrives, and falls back to the
 * theme's primary colour until then. Both fill and stroke are set, so one skin serves either kind
 * of outline.
 */
class FacePartBehavior extends Behavior {
  hasPalette = false
  primary = DEFAULT_FACE_PRIMARY_COLOR

  onFaceSkin(shape, palette) {
    try {
      this.hasPalette = true
      shape.skin = palette.primary
    } catch (error) {
      trace(`[face-smile] onFaceSkin failed: ${errorMessage(error)}\n`)
    }
  }

  applyThemeColor(shape, face) {
    if (this.hasPalette) return
    const primary = toPiuColorNumber(face.theme.primary)
    if (primary === this.primary) return
    this.primary = primary
    shape.skin = getFillStrokeSkin(primary)
  }
}

const VectorMouth = Shape.template(() => ({
  left: 0,
  top: 0,
  width: DEFAULT_FACE_WIDTH,
  height: DEFAULT_FACE_HEIGHT,
  skin: getFillStrokeSkin(DEFAULT_FACE_PRIMARY_COLOR),
  Behavior: class extends FacePartBehavior {
    #emotion = Emotion.NEUTRAL
    #openStep = quantizeUnit(0)
    #weightStep = -1

    onCreate(shape) {
      try {
        this.#update(shape, Emotion.NEUTRAL, quantizeUnit(0), true)
      } catch (error) {
        trace(`[face-smile] mouth onCreate failed: ${errorMessage(error)}\n`)
      }
    }

    onFaceState(shape, face) {
      try {
        this.applyThemeColor(shape, face)
        this.#update(shape, face.emotion, quantizeUnit(face.mouth.open), false)
      } catch (error) {
        trace(`[face-smile] mouth onFaceState failed: ${errorMessage(error)}\n`)
      }
    }

    #update(shape, emotion, openStep, force) {
      if (!force && emotion === this.#emotion && openStep === this.#openStep && intensityStep === this.#weightStep) {
        return
      }
      this.#emotion = emotion
      this.#openStep = openStep
      this.#weightStep = intensityStep
      const outline = getMouthOutline(emotion, openStep, intensityStep)
      if (isFilledMouth(emotion, openStep)) {
        shape.strokeOutline = undefined
        shape.fillOutline = outline
      } else {
        shape.fillOutline = undefined
        shape.strokeOutline = outline
      }
    }
  },
}))

const Eyebrow = Shape.template((data) => ({
  left: 0,
  top: 0,
  width: DEFAULT_FACE_WIDTH,
  height: DEFAULT_FACE_HEIGHT,
  skin: getFillStrokeSkin(DEFAULT_FACE_PRIMARY_COLOR),
  Behavior: class extends FacePartBehavior {
    #side = data.side
    #emotion = Emotion.NEUTRAL
    #weightStep = -1

    onCreate(shape) {
      try {
        this.#update(shape, Emotion.NEUTRAL, true)
      } catch (error) {
        trace(`[face-smile] eyebrow onCreate failed: ${errorMessage(error)}\n`)
      }
    }

    onFaceState(shape, face) {
      try {
        this.applyThemeColor(shape, face)
        this.#update(shape, face.emotion, false)
      } catch (error) {
        trace(`[face-smile] eyebrow onFaceState failed: ${errorMessage(error)}\n`)
      }
    }

    #update(shape, emotion, force) {
      if (!force && emotion === this.#emotion && intensityStep === this.#weightStep) return
      this.#emotion = emotion
      this.#weightStep = intensityStep
      shape.fillOutline = getEyebrowOutline(this.#side, emotion, intensityStep)
    }
  },
}))

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

/** Same shape as SimpleFace (behaviors/face.ts:267-283), with eyebrows and a vector mouth added. */
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
      new Eyebrow({ side: 'left' }),
      new Eyebrow({ side: 'right' }),
      new Eye({ cx: EYE_LEFT_CX, cy: 33, radius: 8, side: 'left' }),
      new Eye({ cx: EYE_RIGHT_CX, cy: 36, radius: 8, side: 'right' }),
      new VectorMouth({}),
    ],
    Behavior: createSmileFaceBehavior(data.onTouch),
  }
})

/**
 * Builds a new face container for robot.ui.setFace(...): behaves like the stock SimpleFace (eyes,
 * blinking, breathing, theme colours, mouth-open / TTS lip sync) with a mouth and eyebrows that
 * react to all eight emotions, at an intensity set by setEmotionIntensity().
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
