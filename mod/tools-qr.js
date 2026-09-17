/*
 * show_qr: a scannable QR code on the 320x240 screen, fenced hard.
 *
 * Cycle 2's design doc (docs/internal/face-and-screen-tools-design.md) rejects a general
 * "draw anything" tool because it would let a network client put arbitrary content on a screen in
 * someone's home. A QR code is a *stronger* version of that problem, not a weaker one: it is an
 * actionable link the robot lends its trust to, and the person scanning it cannot see where it
 * goes before their phone follows it. So this ships fenced, not general-purpose:
 *
 *   - http:// or https:// only. A strict prefix check, not a URL parser - see validateUrl.
 *   - the decoded host is drawn as text under the code, so a person can read where it points
 *     before scanning.
 *   - a short maximum duration (1..60s, default 20), same shape as show_message's `seconds`.
 *   - a length cap on the whole URL (300 chars), refused above that.
 *
 * QRCode mechanics, verified against ~/code/3rd-party/moddable (piu/MC/qrcode) and
 * ~/code/3rd-party/stack-chan (modules/ui/manifest.json) source, not assumed:
 *
 *   - `modules/ui/manifest.json` includes `$(MODDABLE)/modules/piu/MC/qrcode/manifest.json`, whose
 *     own manifest maps the module specifier `piu/QRCode` (not `piu/MC/qrcode`) to `./piuQRCode`
 *     and preloads it, so `globalThis.QRCode` is set before any MOD code runs. `piuQRCode.js` also
 *     exports it by name and by default, so it can be imported directly instead of read off
 *     globalThis - clearer, and it satisfies this repo's Biome config (see the Label note below).
 *   - `QRCode` is a Piu `Content` (`piuQRCode.js`: `__proto__: Content.prototype`), not a
 *     `Container`, so it cannot be handed to `robot.ui.setMain` on its own - screen.js's
 *     `showContent` expects a Container, and `QRCode` has no `.add()`. It is wrapped in one here.
 *   - The encode does NOT happen in `new QRCode({string, ...})` (`PiuQRCode_create` in
 *     piuQRCode.c only stores the string/maxVersion pointers). It happens in `PiuQRCodeBind`,
 *     which runs when the QRCode is bound into an already-live application tree - i.e. inside
 *     `container.add()`, which `robot.ui.setMain(content)` performs synchronously. screen.js's
 *     `showContent` already wraps that call in try/catch, so a failed encode surfaces as a thrown
 *     Error there, on our own call stack, not as an uncaught exception from a later async pass.
 *   - The failure message for "too long to fit" is **not** `"can't fit"` as prior research
 *     assumed. `data/qrcode/qrcode.c` has two distinct error paths: `"can't fit"` fires only when
 *     a caller asks for `bitmap`/`fit` scaling (the low-level `commodetto/qrcode` API,
 *     `pocoqrcode.c`'s callers), which `piuQRCode.js`'s `QRCodeBuffer` call never requests (it
 *     passes only `{input, maxVersion}`). What actually throws when the text does not fit any
 *     version up to `maxVersion` is `xsUnknownError("qrcode failed")` (qrcode.c:92). Either way
 *     it is synchronous and caught by screen.js - moot in practice anyway, since medium-ECC byte
 *     mode at the default `maxVersion` (40) holds roughly 1.6 KB, far above our 300-char cap.
 */
import { fontForSize } from 'font-probe'
import { QRCode } from 'piu/QRCode'
import { showContent } from 'screen'

const MAX_URL_LENGTH = 300
const MAX_HOST_DISPLAY = 42
const SECONDS_MIN = 1
const SECONDS_MAX = 60
const SECONDS_DEFAULT = 20
const SCREEN_WIDTH = 320
const QR_SIZE = 200
const QR_TOP = 6
const LABEL_HEIGHT = 30
const BACKGROUND = '#ffffff'
const TEXT_COLOR = '#000000'

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

/**
 * Fences the argument to http(s) links only, plus a length cap. Deliberately a strict prefix
 * check and nothing cleverer: this is the whole control, not a first pass at one. `javascript:`,
 * `data:`, a wifi join string, a bare phone number and plain text are all refused here. The scheme
 * is compared case-insensitively because schemes are case-insensitive (RFC 3986) and refusing
 * `HTTPS://` would be a false rejection rather than a safety property; nothing after the scheme is
 * touched, normalised or reinterpreted.
 */
function validateUrl(text) {
  if (typeof text !== 'string' || text.length === 0) throw new Error('text is required')
  if (text.length > MAX_URL_LENGTH) {
    throw new Error(`text must be ${MAX_URL_LENGTH} characters or fewer (got ${text.length})`)
  }
  const scheme = text.slice(0, 8).toLowerCase()
  if (!(scheme.startsWith('http://') || scheme.startsWith('https://'))) {
    throw new Error(
      'only http:// or https:// links are allowed - show_qr will not encode javascript:, data:, a wifi-join ' +
        'string, a phone number or plain text, because the robot would be lending a scannable link its trust ' +
        'with no way for the person scanning it to see where it goes',
    )
  }
  return text
}

/**
 * Pulls "host[:port]" out of an http(s) URL for display, without a URL parser: strip the scheme,
 * take up to the first of / ? #, drop anything before the last @ (userinfo). Tolerant by design -
 * this text exists to inform a person, not to validate, so anything it cannot make sense of falls
 * back to a placeholder rather than throwing.
 */
function extractHost(url) {
  const schemeEnd = url.indexOf('://')
  if (schemeEnd < 0) return '(unknown host)'
  const rest = url.slice(schemeEnd + 3)
  const authorityEnd = rest.search(/[/?#]/)
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd)
  const at = authority.lastIndexOf('@')
  const hostPort = at === -1 ? authority : authority.slice(at + 1)
  return hostPort.length > 0 ? hostPort : '(unknown host)'
}

/**
 * Shortens a host for display, keeping the *tail*, not the head. The registrable domain that
 * actually says where a link goes sits at the right end of a hostname
 * (`accounts.google.com.evil.example` is evil.example's) - a head-truncation would show exactly
 * the deceptive, trusted-looking prefix and hide the part that matters.
 */
function displayHost(host) {
  if (host.length <= MAX_HOST_DISPLAY) return host
  return `...${host.slice(-(MAX_HOST_DISPLAY - 3))}`
}

/**
 * Builds the Container screen.js's showContent wants: the QR code plus the host text beneath it,
 * on a full-screen white background so nothing from whatever was on screen before shows through.
 *
 * The larger font is used only when font-probe.js already confirmed it resolves on this host -
 * `fontForSize` returns undefined otherwise, and the Label's `style` key is left out entirely in
 * that case so it falls back to the application's own default style, exactly as balloon.js does
 * for its own font. A Style built with an unconfirmed font name is not safe here: Piu resolves
 * fonts lazily, and a Label with no font key at all still renders (it inherits the ambient
 * style), but a Label whose *own* style names a font that has never been resolved would defer
 * that lookup to a later, uncatchable layout pass. Reusing a name font-probe.js already resolved
 * avoids that: Piu's font lookup caches by resolved family/size/weight, so passing the same name
 * again is a cache hit, not a fresh (and here, unverifiable) resource load.
 *
 * `Label` is a real Piu global (`piu/All/piuAll.js` sets `globalThis.Label`, the same way this
 * project already relies on `Container`/`Skin`/`Style`), but unlike `QRCode` it has no JS module
 * to import it from, and this repo's biome.json globals list does not yet include it (only
 * Container/Behavior/Port/Shape/Skin/Style/Texture/Content/Application do). That list is shared
 * config outside this file's ownership, so the reference below is scoped with a biome-ignore
 * rather than left to fail scripts/check.sh; worth adding "Label" there properly.
 */
function buildQrContent(url, host) {
  const font = fontForSize('large')
  const label = displayHost(host)
  const labelDictionary = { left: 4, right: 4, bottom: 2, height: LABEL_HEIGHT, string: label }
  if (font) labelDictionary.style = { font, color: TEXT_COLOR, horizontal: 'center' }
  return new Container(null, {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    skin: new Skin({ fill: BACKGROUND }),
    contents: [
      // Two arguments, not one: a Piu template is `new Template(behaviorData, dictionary)`, and
      // PiuQRCodeDictionary reads `string` out of the *dictionary*. Passing one object leaves the
      // QRCode with no string, so PiuQRCodeBind never encodes and PiuQRCodeDraw draws nothing -
      // which looks exactly like a working tool against a white background.
      new QRCode(null, {
        left: (SCREEN_WIDTH - QR_SIZE) >> 1,
        top: QR_TOP,
        width: QR_SIZE,
        height: QR_SIZE,
        string: url,
      }),
      new Label(null, labelDictionary),
    ],
  })
}

export function qrTools(robot) {
  return [
    {
      name: 'show_qr',
      description:
        'Show a QR code on the robot screen for a link, so a person nearby can scan it with their phone. ' +
        'Fenced to http:// and https:// URLs only (lowercase scheme, 300 characters max) - nothing else is ' +
        'accepted, because a QR code is an actionable link the robot lends its trust to and the person scanning ' +
        'it cannot see where it points. The decoded host is shown as text under the code so they can check it ' +
        'first. Restores the face automatically after seconds (1..60, default 20).',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'The link to encode. Must start with http:// or https://; refused otherwise. Max 300 characters.',
          },
          seconds: {
            type: 'number',
            description: 'Seconds to show the code before restoring the face, 1..60 (default 20).',
          },
        },
        required: ['text'],
      },
      handler: (args) => {
        const url = validateUrl(args.text)
        let seconds = SECONDS_DEFAULT
        if (args.seconds !== undefined) {
          if (typeof args.seconds !== 'number' || !Number.isFinite(args.seconds)) {
            throw new Error('seconds must be a number')
          }
          seconds = clamp(args.seconds, SECONDS_MIN, SECONDS_MAX)
        }
        const host = extractHost(url)
        let content
        try {
          content = buildQrContent(url, host)
        } catch (error) {
          throw new Error(`could not build the QR code: ${errorMessage(error)}`)
        }
        const holdMs = showContent(robot, 'qr', content, seconds * 1000)
        return `Showing a QR code for ${host}, for ${Math.round(holdMs / 1000)}s.`
      },
    },
  ]
}

export default qrTools
