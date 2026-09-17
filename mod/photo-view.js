/*
 * The captured-photo view: what `camera_take_photo`'s `show_on_screen` puts up in place of the face.
 *
 * The firmware has a real bitmap preview already - `modules/camera/device/camera-preview.ts` - but it
 * is not registered in any module map a MOD can import (see docs/internal/face-and-display-research.md
 * and the "Cycle 2 - the screen" section of docs/internal/face-and-screen-tools-design.md for the
 * source reading behind this file). Everything *it* uses is mapped, though, so this replicates its
 * approach: `commodetto/Bitmap` + `runtime-bitmap-port` blit the raw RGB565 frame directly - no PNG or
 * JPEG decode, because the device has neither - and the generic `camera-preview` module (mosaic-only,
 * 48px blocks) is kept as the fallback for whenever the bitmap path does not pan out.
 *
 * Both `commodetto/Bitmap` and `runtime-bitmap-port` are mapped in the firmware's own
 * `modules/ui/manifest.json`, the same manifest that already supplies `behaviors/face` and `parts/eye`
 * to `face-smile.js` - so this is the same "MOD sees the whole host module registry" route that file
 * already relies on, not a new one.
 */
import { createCameraPreviewDialog, prepareCameraPreviewFrame } from 'camera-preview'
import { copyRgb565Frame } from 'camera-preview-utils'
import Bitmap from 'commodetto/Bitmap'
import config from 'mc/config'
import { Container, Skin } from 'piu/MC'
import RuntimeBitmapPort from 'runtime-bitmap-port'

// The size the firmware's own preview validates and centers on a 320x240 screen. Not full-screen:
// the camera DMA sdkconfig notes warn that PSRAM transfers corrupt RGB565 frames when they compete
// with the display, and this is the only size anyone has reasoned through.
export const PHOTO_VIEW_WIDTH = 200
export const PHOTO_VIEW_HEIGHT = 120
const PREVIEW_LEFT = 60
const PREVIEW_TOP = 60
// Hex, not a CSS color name: the firmware's own preview dialogs (camera-preview.ts, camera-preview-view.ts)
// only ever use hex fill strings, and that is the only form seen proven against this Skin parser.
const BACKGROUND = '#000000'

// Match the display's own pixel byte order so the raw camera buffer blits with no per-pixel
// conversion, exactly as `camera-preview.ts` does (`PREVIEW_BITMAP_FORMAT`, its lines 43-47) - it
// reads the same `mc/config`. Confirmed by source, not by device: this MOD's own `tools-events.js`
// already imports `mc/config`, and the m5stackchan_cores3 platform manifest that
// `scripts/build.sh` builds against sets `config.format` to `"RGB565BE"` (moddable/build/devices/
// esp32/targets/m5stack_cores3/manifest.json). RGB565BE is also the fallback if `config.format` is
// ever missing, because that is what this specific display uses - unlike the firmware file this
// copies, which falls back to RGB565LE for a generic target.
const BITMAP_FORMAT = (() => {
  const name = typeof config?.format === 'string' ? config.format : undefined
  const value = name ? Bitmap[name] : undefined
  return typeof value === 'number' ? value : Bitmap.RGB565BE
})()
const BITMAP_BYTE_ORDER = BITMAP_FORMAT === Bitmap.RGB565BE ? 'be' : 'le'

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function isRgb565(frame) {
  return frame?.imageType === 'rgb565le' || frame?.imageType === 'rgb565be'
}

/** The real photo: a Piu Container blitting the raw RGB565 frame via RuntimeBitmapPort. Throws on any problem; the caller falls back to the mosaic. */
function buildBitmapView(frame) {
  if (!isRgb565(frame)) throw new Error(`unsupported image type: ${frame?.imageType}`)
  const buffer = copyRgb565Frame(frame, {
    width: PHOTO_VIEW_WIDTH,
    height: PHOTO_VIEW_HEIGHT,
    byteOrder: BITMAP_BYTE_ORDER,
  })
  if (buffer.byteLength < PHOTO_VIEW_WIDTH * PHOTO_VIEW_HEIGHT * 2) {
    throw new Error('resampled frame is short')
  }
  const bitmap = new Bitmap(PHOTO_VIEW_WIDTH, PHOTO_VIEW_HEIGHT, BITMAP_FORMAT, buffer, 0)

  const previewPort = new RuntimeBitmapPort(
    { bitmap },
    {
      left: PREVIEW_LEFT,
      top: PREVIEW_TOP,
      width: PHOTO_VIEW_WIDTH,
      height: PHOTO_VIEW_HEIGHT,
      active: false,
      Behavior: class extends Behavior {
        onCreate(_port, data) {
          this.bitmap = data.bitmap
        }
        onDisplaying(port) {
          port.invalidate()
        }
        onUndisplaying(port) {
          try {
            port.clearBitmap?.()
          } catch (error) {
            trace(`[photo-view] clearBitmap failed: ${errorMessage(error)}\n`)
          }
          this.bitmap = null
        }
        onDraw(port) {
          // A fill first, same as the firmware's own preview: if the bitmap draw fails partway or
          // `this.bitmap` was already cleared (onUndisplaying raced a late redraw), the port still
          // paints something sane instead of showing whatever pixels were here before.
          port.fillColor(BACKGROUND, 0, 0, PHOTO_VIEW_WIDTH, PHOTO_VIEW_HEIGHT)
          if (!this.bitmap) return
          port.drawBitmap(this.bitmap, 0, 0, 0, 0, PHOTO_VIEW_WIDTH, PHOTO_VIEW_HEIGHT)
        }
      },
    },
  )

  return new Container(null, {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    skin: new Skin({ fill: BACKGROUND }),
    contents: [previewPort],
  })
}

/** The fallback: the firmware's own generic preview dialog, 48px mosaic blocks, no raw blit. */
function buildMosaicView(frame) {
  const preview = prepareCameraPreviewFrame(frame)
  return createCameraPreviewDialog(preview)
}

/**
 * Builds the on-screen view for a just-captured frame, for `robot.ui.setMain(...)`.
 *
 * `frame` is `{ width, height, imageType, buffer }` - the same shape `robot.camera.capture(...)`
 * returns, minus `close`. Read it before the frame is closed; nothing here keeps a reference to
 * `frame.buffer` itself; `copyRgb565Frame` copies out of it into a fresh buffer immediately.
 *
 * Returns `{ content, mode }`. `mode` is `'bitmap'` for the real photo, or `'mosaic'` if the bitmap
 * path was unavailable and this fell back to the coarse preview - 15 colored rectangles for a
 * 200x120 frame, not a picture. Callers must say which one they got.
 */
export function createPhotoView(frame) {
  try {
    return { content: buildBitmapView(frame), mode: 'bitmap' }
  } catch (bitmapError) {
    trace(`[photo-view] bitmap view failed, falling back to mosaic: ${errorMessage(bitmapError)}\n`)
    try {
      return { content: buildMosaicView(frame), mode: 'mosaic' }
    } catch (mosaicError) {
      throw new Error(
        `photo view unavailable: bitmap path failed (${errorMessage(bitmapError)}), mosaic fallback also failed (${errorMessage(mosaicError)})`,
      )
    }
  }
}

export default createPhotoView
