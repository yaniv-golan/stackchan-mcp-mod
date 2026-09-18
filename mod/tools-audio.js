/*
 * Audio tools for stackchan-mcp-mod: microphone loudness analysis, tone and TTS-koe singing, and
 * speaker playback (robot.audio.*).
 *
 * Same response-size ceiling as tools-camera.js applies here: an oversized response body
 * never finishes sending and takes the HTTP server down. This device's mic format is 16 kHz,
 * 16-bit, stereo (~64 KB per second of raw audio; see WAV_HEADER_SIZE users below), so raw
 * recordings are never returned. `mic_listen` and `mic_record_and_play` only ever return a text
 * loudness summary. `mic_get_audio` downsamples to a small mono WAV and refuses anything that would
 * not fit under MAX_AUDIO_BYTES.
 */
const WAV_HEADER_SIZE = 44

const LISTEN_DURATION_DEFAULT_MS = 2000
const LISTEN_DURATION_MIN_MS = 200
const LISTEN_DURATION_MAX_MS = 5000

const TONE_HZ_MIN = 100
const TONE_HZ_MAX = 8000
const TONE_DURATION_MIN_MS = 20
const TONE_DURATION_MAX_MS = 3000
const VOLUME_MIN = 0
const VOLUME_MAX = 1

const KOE_MAX_LENGTH = 200

const GET_AUDIO_DURATION_DEFAULT_MS = 1000
// Compensates the ~30 dB quiet capture path so returned audio is audible without asking every time.
const DEFAULT_SOFTWARE_GAIN = 16
const GET_AUDIO_DURATION_MIN_MS = 200
const GET_AUDIO_DURATION_MAX_MS = 2000
// Measured on the device (see tools-camera.js): an oversized response body never
// finishes sending. 20000 bytes of WAV is the ceiling this tool will ever try to return.
// What the device can send is a RESPONSE BODY budget, and the body carries base64 (4 bytes per 3) plus
// a JSON envelope - so the raw WAV budget is the body budget scaled back down, not the body budget.
const MAX_BODY_BYTES = 28000
const ENVELOPE_ALLOWANCE = 1200
const MAX_AUDIO_BYTES = Math.floor(((MAX_BODY_BYTES - ENVELOPE_ALLOWANCE) * 3) / 4)
const MIN_AUDIO_BYTES = 1000
// Refuse to downsample further than this; beyond it the audio is too mangled to be worth sending.
const MAX_DECIMATION_FACTOR = 8

// Loudness bands, as RMS dBFS straight off the wire - no offset. The previous bands added a 30 dB
// allowance that had been measured on a PEAK and applied to an RMS reading, with speech as the only anchor
// and no measured empty room, so a silent room read -50.5 dBFS, became -20.5, and was labelled
// "conversation level" - while "silent" needed raw < -80 and "quiet" raw < -60, neither of which this
// microphone can reach. Speech RMS sits 12-20 dB below its own peak, which is the whole of that error, and
// the crest factors measured below (15-17 dB on room noise) sit squarely in that band.
//
// Anchored 2026-09-18 on measurements in docs/device-notes.md:
//   empty room (occupied, nobody speaking)  -47.5 and -51.4 dBFS RMS
//   speech at arm's length                  -42 dBFS RMS
// Only ONE boundary has to fall between those: "silent" sits below the room and "loud" above speech. It is
// placed at -45, which is 2.5 dB above the louder room sample and 3 dB below speech. That is thin, and it
// is thin because the anchors are 5.5 dB apart - two samples of one room, no clap anchor, one speech
// figure. Do not widen these without measuring again, and do not read them as precise.
//
// **2.5 dB does not survive a noisier room.** Those samples are a late-evening room with one person sitting
// still. A daytime room with HVAC, a fan or a street outside is comfortably more than 2.5 dB above that, and
// would read "conversation level" with nobody in it - the original bug, with a correct derivation. No
// placement inside a 5.5 dB window avoids this; it is a limit of thresholding absolute RMS at all. See
// docs/device-notes.md for the approach that would replace it.
//
// `silent` means dead air - a disconnected or failed capture path - not a quiet room. It is placed at -90
// rather than near the room level, because level cannot tell those two apart and guessing at it got this
// wrong once already: -54 was set from occupied-room samples, and an UNOCCUPIED room measured -55.2, so a
// working robot in a quiet house reported its own microphone as broken. An empty room is `quiet`.
//
// -90 separates them by construction instead of by margin. A disconnected ADC returns zeros, and toDbfs
// floors those at DBFS_FLOOR (-96); this microphone's own noise floor is about -56 dBFS with a 7 dB spread
// across slices (docs/device-notes.md, measured 2026-09-18). 34 dB apart, so no room can reach it.
//
// What this does NOT do is detect a *stuck* capture path that returns a constant non-zero value. That needs
// slice variance, not a level - see the note in device-notes.md.
const SILENT_DBFS = -90
const QUIET_DBFS = -45
const CONVERSATION_DBFS = -30
// Floor used in place of -Infinity for a zero-amplitude sample.
const DBFS_FLOOR = -96

// Loudness is reported per this many milliseconds of audio, so a caller can tell when sound
// happened during the recording without needing the raw samples.
const SLICE_DURATION_MS = 200

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function normalizeInteger(value, name, fallback, min, max) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return Math.trunc(clamp(value, min, max))
}

function requireClampedNumber(args, name, min, max) {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} is required and must be a number`)
  return clamp(value, min, max)
}

function requireClampedInteger(args, name, min, max) {
  return Math.round(requireClampedNumber(args, name, min, max))
}

function optionalClampedNumber(args, name, min, max) {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return clamp(value, min, max)
}

function toDbfs(amplitude) {
  if (!(amplitude > 0)) return DBFS_FLOOR
  return Math.max(DBFS_FLOOR, 20 * Math.log10(amplitude))
}

/**
 * This robot's capture path runs about 30 dB quiet: a hard clap next to the microphone peaks at only
 * -30 dBFS, where it should be near full scale, and the samples are clean audio at a tiny amplitude.
 * The qualitative thresholds below are therefore calibrated to THIS hardware rather than to the usual
 * dBFS figures - without that, ordinary speech reads as "silent". The number is an allowance for the
 * quiet capture path, not a correction to the dBFS reading itself, which is relative to full scale and
 * does not move. It was measured on a peak and is applied to an RMS reading, so treat it as a rule of
 * thumb for the label, not as a calibrated conversion.
 */
const QUIET_PATH_ALLOWANCE_DB = 30

function qualitativeLevel(rawDbfs) {
  if (rawDbfs < SILENT_DBFS) return 'silent'
  if (rawDbfs < QUIET_DBFS) return 'quiet'
  if (rawDbfs < CONVERSATION_DBFS) return 'conversation level'
  return 'loud'
}

/**
 * Reads the fields of a standard 44-byte WAV header (as written by the host's Microphone.record,
 * host/modules/audio/microphone.ts) with a little-endian DataView. Returns undefined when the
 * buffer is too small to hold a header.
 */
function parseWavHeader(buffer) {
  if (buffer.byteLength < WAV_HEADER_SIZE) return undefined
  const view = new DataView(buffer)
  const channels = view.getUint16(22, true)
  const sampleRate = view.getUint32(24, true)
  const bitsPerSample = view.getUint16(34, true)
  const declaredDataBytes = view.getUint32(40, true)
  const availableDataBytes = buffer.byteLength - WAV_HEADER_SIZE
  return {
    channels,
    sampleRate,
    bitsPerSample,
    dataBytes: Math.max(0, Math.min(declaredDataBytes, availableDataBytes)),
  }
}

/**
 * Computes overall RMS/peak (0..1 of full scale) plus one RMS value per ~200ms slice, from 16-bit
 * PCM samples interleaved across `channels`. All channels are pooled together for a single overall
 * reading; ESP32 and the WAV format are both little-endian so getInt16(..., true) matches.
 */
function analyzeLoudness(buffer, header) {
  const { channels, sampleRate, bitsPerSample, dataBytes } = header
  const view = new DataView(buffer)
  const frameCount = channels > 0 ? Math.floor(dataBytes / (channels * 2)) : 0
  const sliceFrames = Math.max(1, Math.round((sampleRate * SLICE_DURATION_MS) / 1000))

  let sumSquares = 0
  let sampleCount = 0
  let peak = 0
  const slices = []
  let sliceSumSquares = 0
  let sliceSampleCount = 0

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = WAV_HEADER_SIZE + (frame * channels + channel) * 2
      const amplitude = view.getInt16(offset, true) / 32768
      const magnitude = Math.abs(amplitude)
      sumSquares += amplitude * amplitude
      sliceSumSquares += amplitude * amplitude
      sampleCount += 1
      sliceSampleCount += 1
      if (magnitude > peak) peak = magnitude
    }
    const isLastFrame = frame === frameCount - 1
    if ((frame + 1) % sliceFrames === 0 || isLastFrame) {
      slices.push(sliceSampleCount > 0 ? Math.sqrt(sliceSumSquares / sliceSampleCount) : 0)
      sliceSumSquares = 0
      sliceSampleCount = 0
    }
  }

  return {
    frameCount,
    rms: sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0,
    peak,
    slices,
    bitsPerSample,
  }
}

function formatLoudnessSummary(buffer, requestedMs) {
  if (buffer.byteLength === 0) {
    return `Recording failed: the microphone returned an empty buffer (0 bytes) for a ${requestedMs} ms request.`
  }
  const header = parseWavHeader(buffer)
  if (!header) {
    return `Recording failed: buffer (${buffer.byteLength} bytes) is too small to contain a WAV header.`
  }
  const lines = [
    `Recorded ~${requestedMs} ms: ${header.sampleRate} Hz, ${header.channels} channel(s), ${header.bitsPerSample}-bit, ${buffer.byteLength} bytes total (${header.dataBytes} bytes of audio data).`,
  ]
  if (header.bitsPerSample !== 16) {
    lines.push(`Loudness not computed: sample width is ${header.bitsPerSample}-bit, only 16-bit is supported.`)
    return lines.join('\n')
  }
  if (header.dataBytes < 2) {
    lines.push('Loudness not computed: no audio data samples were captured.')
    return lines.join('\n')
  }
  const { rms, peak, slices } = analyzeLoudness(buffer, header)
  const rmsDbfs = toDbfs(rms)
  const peakDbfs = toDbfs(peak)
  lines.push(
    `Loudness: RMS ${rms.toFixed(3)} (${rmsDbfs.toFixed(1)} dBFS), peak ${peak.toFixed(3)} (${peakDbfs.toFixed(1)} dBFS) — ${qualitativeLevel(rmsDbfs)}.`,
  )
  lines.push(
    `This robot's capture path runs about ${QUIET_PATH_ALLOWANCE_DB} dB quiet, so these dBFS numbers are far below what the same room would read on other hardware; the bands above are calibrated to this robot, not to usual dBFS figures.`,
  )
  // A linear 0-100 scale on amplitude reads 0 for every slice at any level this hardware reaches short of
  // a shout - an empty room measures RMS 0.003, and round(0.3) is 0 - so the row was a line of zeros under
  // a headline saying someone was talking. dBFS spans the range the microphone actually produces.
  lines.push(
    `Per ~${SLICE_DURATION_MS}ms slice RMS, dBFS: ${slices.map((value) => toDbfs(value).toFixed(0)).join(',')}`,
  )
  // The hardware preamp is out of reach from a MOD, so tell the caller what headroom is left.
  const advice = gainAdvice(peak)
  if (advice) lines.push(advice.trim())
  return lines.join('\n')
}

/** Writes a standard 44-byte WAV header, mirroring host/modules/audio/microphone.ts's layout. */
function writeWavHeader(view, { sampleRate, channels, bitsPerSample, dataLength }) {
  const byteRate = sampleRate * channels * (bitsPerSample >> 3)
  view.setUint8(0, 'R'.charCodeAt(0))
  view.setUint8(1, 'I'.charCodeAt(0))
  view.setUint8(2, 'F'.charCodeAt(0))
  view.setUint8(3, 'F'.charCodeAt(0))
  view.setUint32(4, 36 + dataLength, true)
  view.setUint8(8, 'W'.charCodeAt(0))
  view.setUint8(9, 'A'.charCodeAt(0))
  view.setUint8(10, 'V'.charCodeAt(0))
  view.setUint8(11, 'E'.charCodeAt(0))
  view.setUint8(12, 'f'.charCodeAt(0))
  view.setUint8(13, 'm'.charCodeAt(0))
  view.setUint8(14, 't'.charCodeAt(0))
  view.setUint8(15, ' '.charCodeAt(0))
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // AudioFormat = 1 (PCM)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, (channels * bitsPerSample) >> 3, true)
  view.setUint16(34, bitsPerSample, true)
  view.setUint8(36, 'd'.charCodeAt(0))
  view.setUint8(37, 'a'.charCodeAt(0))
  view.setUint8(38, 't'.charCodeAt(0))
  view.setUint8(39, 'a'.charCodeAt(0))
  view.setUint32(40, dataLength, true)
}

/** Smallest integer decimation factor (1..MAX_DECIMATION_FACTOR) that fits frameCount mono 16-bit
 * samples plus a 44-byte header under maxBytes, or undefined if even the cap does not fit. */
function chooseDecimationFactor(frameCount, maxBytes) {
  const maxOutFrames = Math.floor((maxBytes - WAV_HEADER_SIZE) / 2)
  if (maxOutFrames <= 0) return undefined
  const needed = Math.max(1, Math.ceil(frameCount / maxOutFrames))
  return needed <= MAX_DECIMATION_FACTOR ? needed : undefined
}

/**
 * Downmixes interleaved 16-bit PCM to mono and decimates by `factor`, averaging every collapsed
 * group of samples (across channels and across time) instead of dropping them, as a crude low-pass
 * to reduce aliasing. Returns a brand new, correctly-headed mono WAV as a Uint8Array.
 */
function buildDecimatedMonoWav(buffer, header, factor) {
  const { channels, sampleRate, dataBytes } = header
  const view = new DataView(buffer)
  const frameCount = Math.floor(dataBytes / (channels * 2))
  const outFrames = Math.max(1, Math.ceil(frameCount / factor))
  const dataLength = outFrames * 2
  const out = new Uint8Array(WAV_HEADER_SIZE + dataLength)
  const outView = new DataView(out.buffer)
  const newSampleRate = Math.max(1, Math.round(sampleRate / factor))

  writeWavHeader(outView, { sampleRate: newSampleRate, channels: 1, bitsPerSample: 16, dataLength })

  for (let outFrame = 0; outFrame < outFrames; outFrame += 1) {
    const startFrame = outFrame * factor
    const endFrame = Math.min(startFrame + factor, frameCount)
    let sum = 0
    let count = 0
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        sum += view.getInt16(WAV_HEADER_SIZE + (frame * channels + channel) * 2, true)
        count += 1
      }
    }
    const sample = count > 0 ? Math.round(sum / count) : 0
    outView.setInt16(WAV_HEADER_SIZE + outFrame * 2, sample, true)
  }

  return { bytes: out, newSampleRate, outFrames }
}

/**
 * Applies software gain to 16-bit PCM in place, clamping at the 16-bit limits.
 * This robot's capture path runs about 30 dB quiet (a hard clap peaks near -30 dBFS), so scaling up uses
 * headroom that is otherwise wasted. It raises the noise floor equally - it does not improve signal to
 * noise, and the hardware gain that would cannot be reached from a MOD.
 */
function applyGain(view, dataOffset, dataBytes, gain) {
  if (gain === 1) return 0
  let clipped = 0
  for (let offset = dataOffset; offset + 1 < dataOffset + dataBytes; offset += 2) {
    const scaled = Math.round(view.getInt16(offset, true) * gain)
    if (scaled > 32767 || scaled < -32768) clipped += 1
    view.setInt16(offset, Math.max(-32768, Math.min(32767, scaled)), true)
  }
  return clipped
}

function normalizeGain(value, name, fallback = 1) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return Math.max(1, Math.min(32, value))
}

/** Suggests how much software gain the measured peak leaves room for. */
function gainAdvice(peak) {
  if (peak <= 0) return ''
  const headroom = 0.9 / peak
  if (headroom < 1.5) return ' Levels already use the available range.'
  return ` About ${headroom.toFixed(1)}x software gain would fill the range (pass gain to mic_record_and_play or mic_get_audio).`
}

export function audioTools(robot, { policy, indicators } = {}) {
  const audio = robot.audio
  if (!audio) return []

  /**
   * Prompts the person in front of the robot while the microphone is open, so they know when to talk,
   * and lights the LED indicator - which is what shows a recording is happening when the screen is blank.
   */
  const withPrompt = async (text, action) => {
    if (indicators) return indicators.microphone(text, action)
    try {
      robot.ui.showBalloon(text)
    } catch (error) {
      trace(`[mcp-mod] record prompt failed: ${errorMessage(error)}\n`)
    }
    try {
      return await action()
    } finally {
      try {
        robot.ui.hideBalloon()
      } catch (error) {
        trace(`[mcp-mod] record prompt hide failed: ${errorMessage(error)}\n`)
      }
    }
  }

  const tools = []
  let busy = false

  // capabilities.ts marks `microphone` optional on AudioCapability (`microphone?: {...}`);
  // `record` itself always exists as a method but throws when no microphone is present
  // (host/app/runtime-audio.ts), so both are checked here to decide whether to expose recording.
  // `off` means the recording tools are never registered; the speaker-only tools stay available.
  const canRecord = typeof audio.record === 'function' && Boolean(audio.microphone) && (policy?.enabled ?? true)

  if (canRecord) {
    tools.push(
      {
        name: 'mic_listen',
        description:
          'Record from the microphone for duration_ms (integer, default 2000, clamped 200..5000) and report how loud it was: sample format, overall and peak RMS loudness (0..1 and dBFS), a qualitative level, and loudness per ~200ms slice. This does NOT transcribe speech — it only measures loudness.',
        inputSchema: {
          type: 'object',
          properties: {
            duration_ms: {
              type: 'integer',
              description: 'Recording length in milliseconds, default 2000, clamped 200..5000',
            },
          },
        },
        handler: async (args) => {
          const durationMs = normalizeInteger(
            args.duration_ms,
            'duration_ms',
            LISTEN_DURATION_DEFAULT_MS,
            LISTEN_DURATION_MIN_MS,
            LISTEN_DURATION_MAX_MS,
          )
          if (busy) throw new Error('microphone is busy with another recording')
          busy = true
          try {
            const buffer = await withPrompt('Listening...', () => audio.record(durationMs))
            return formatLoudnessSummary(buffer, durationMs)
          } finally {
            busy = false
          }
        },
      },
      {
        name: 'mic_record_and_play',
        description:
          'Record from the microphone for duration_ms (integer, default 2000, clamped 200..5000), then immediately play the recording back through the speaker. Reports the same loudness summary as mic_listen plus whether playback returned true; false means playback is unsupported or failed on this robot, not that the recording itself failed. Pass gain to amplify the recording in software (the hardware preamp cannot be changed from a MOD).',
        inputSchema: {
          type: 'object',
          properties: {
            duration_ms: {
              type: 'integer',
              description: 'Recording length in milliseconds, default 2000, clamped 200..5000',
            },
            gain: {
              type: 'number',
              description: `Software gain applied before playback, 1..32 (default ${DEFAULT_SOFTWARE_GAIN}, compensating this robot's quiet capture path; pass 1 for the raw recording)`,
            },
          },
        },
        handler: async (args) => {
          const durationMs = normalizeInteger(
            args.duration_ms,
            'duration_ms',
            LISTEN_DURATION_DEFAULT_MS,
            LISTEN_DURATION_MIN_MS,
            LISTEN_DURATION_MAX_MS,
          )
          if (busy) throw new Error('microphone is busy with another recording')
          busy = true
          try {
            const gain = normalizeGain(args.gain, 'gain', DEFAULT_SOFTWARE_GAIN)
            const buffer = await withPrompt('Listening...', () => audio.record(durationMs))
            const summary = formatLoudnessSummary(buffer, durationMs)
            let gainNote = ''
            if (gain !== 1) {
              const header = parseWavHeader(buffer)
              if (header && header.bitsPerSample === 16) {
                const clipped = applyGain(new DataView(buffer), WAV_HEADER_SIZE, header.dataBytes, gain)
                gainNote = `\nApplied ${gain}x software gain before playback${clipped ? `, ${clipped} samples clipped` : ''}.`
              } else {
                gainNote = '\nGain not applied: only 16-bit recordings are supported.'
              }
            }
            const played = await audio.playAudio(buffer)
            return `${summary}${gainNote}\nPlayback returned: ${played}.`
          } finally {
            busy = false
          }
        },
      },
      {
        name: 'mic_get_audio',
        description:
          'Record from the microphone for duration_ms (integer, default 1000, clamped 200..2000), then downmix to mono and downsample it until the resulting WAV fits under max_bytes (default and hard cap 20000, clamped 1000..20000), and return it as an audio resource plus a short summary. Only use this when the actual audio bytes are needed; prefer mic_listen for a loudness summary. Fails if even the maximum downsampling would not fit — retry with a shorter duration_ms.',
        inputSchema: {
          type: 'object',
          properties: {
            duration_ms: {
              type: 'integer',
              description: 'Recording length in milliseconds, default 1000, clamped 200..2000',
            },
            max_bytes: {
              type: 'integer',
              description:
                'Maximum size in bytes of the returned WAV file, default and hard cap 20000, clamped 1000..20000',
            },
            gain: {
              type: 'number',
              description: `Software gain applied to the returned audio, 1..32 (default ${DEFAULT_SOFTWARE_GAIN}, compensating this robot's quiet capture path; pass 1 for the raw recording)`,
            },
          },
        },
        handler: async (args) => {
          const durationMs = normalizeInteger(
            args.duration_ms,
            'duration_ms',
            GET_AUDIO_DURATION_DEFAULT_MS,
            GET_AUDIO_DURATION_MIN_MS,
            GET_AUDIO_DURATION_MAX_MS,
          )
          const maxBytes = normalizeInteger(
            args.max_bytes,
            'max_bytes',
            MAX_AUDIO_BYTES,
            MIN_AUDIO_BYTES,
            MAX_AUDIO_BYTES,
          )
          if (busy) throw new Error('microphone is busy with another recording')
          busy = true
          try {
            const buffer = await withPrompt('Recording...', () => audio.record(durationMs))
            if (buffer.byteLength === 0) throw new Error('the microphone returned no audio; try again')
            const header = parseWavHeader(buffer)
            if (!header) throw new Error('the microphone returned a buffer too small to contain a WAV header')
            if (header.bitsPerSample !== 16) {
              throw new Error(`cannot downsample: recording is ${header.bitsPerSample}-bit, only 16-bit is supported`)
            }
            const frameCount = Math.floor(header.dataBytes / (header.channels * 2))
            const factor = chooseDecimationFactor(frameCount, maxBytes)
            if (factor === undefined) {
              throw new Error(
                `recording is too long to fit under ${maxBytes} bytes even at ${MAX_DECIMATION_FACTOR}x downsampling; use a shorter duration_ms`,
              )
            }
            const gain = normalizeGain(args.gain, 'gain', DEFAULT_SOFTWARE_GAIN)
            const clipped = applyGain(new DataView(buffer), WAV_HEADER_SIZE, header.dataBytes, gain)
            const { bytes, newSampleRate, outFrames } = buildDecimatedMonoWav(buffer, header, factor)
            const summary = `Recorded ~${durationMs} ms (${header.sampleRate} Hz, ${header.channels} ch, ${header.bitsPerSample}-bit), downsampled ${factor}x to mono ${newSampleRate} Hz (${outFrames} samples), ${bytes.length} bytes, under the ${maxBytes} byte limit.${gain !== 1 ? ` Applied ${gain}x software gain${clipped ? `, ${clipped} samples clipped` : ''}.` : ''}`
            return {
              content: [
                {
                  type: 'resource',
                  // blobBytes (not blob): the server base64-encodes these straight into the response
                  // buffer, the same way tools-camera.js's `dataBytes` is handled for images.
                  resource: { uri: 'audio://stackchan/recording.wav', mimeType: 'audio/wav', blobBytes: bytes },
                },
                { type: 'text', text: summary },
              ],
            }
          } finally {
            busy = false
          }
        },
      },
    )
  }

  tools.push({
    name: 'play_tone',
    description:
      'Play a pure tone through the speaker at hz Hz (required, clamped 100..8000) for duration_ms milliseconds (required, clamped 20..3000), at an optional volume (0..1, default the current speaker volume). Resolves once playback finishes.',
    inputSchema: {
      type: 'object',
      properties: {
        hz: { type: 'number', description: 'Tone frequency in Hz, clamped 100..8000' },
        duration_ms: { type: 'integer', description: 'Tone length in milliseconds, clamped 20..3000' },
        volume: { type: 'number', description: 'Playback volume, 0..1 (default: current speaker volume)' },
      },
      required: ['hz', 'duration_ms'],
    },
    handler: async (args) => {
      const hz = requireClampedNumber(args, 'hz', TONE_HZ_MIN, TONE_HZ_MAX)
      const durationMs = requireClampedInteger(args, 'duration_ms', TONE_DURATION_MIN_MS, TONE_DURATION_MAX_MS)
      const volume = optionalClampedNumber(args, 'volume', VOLUME_MIN, VOLUME_MAX)
      await audio.tone(hz, durationMs, volume)
      return `Played a ${hz} Hz tone for ${durationMs} ms${volume === undefined ? '' : ` at volume ${volume}`}.`
    },
  })

  // `sing` only makes sense when the active TTS can stream koe notation. capabilities.ts declares
  // TTS.streamKoe as optional, and runtime-audio.ts's own sing() checks `tts.streamKoe` at call time -
  // that is the capability probed here, not a preference: SECURITY.md states this MOD reads only
  // `mcp.token` and `mcp.capture`, and reading `tts.type` from preferences would break that. Any probe
  // failure is treated as "cannot sing" so a throwing probe cannot reboot the robot.
  let canSing = false
  try {
    canSing = typeof audio.tts?.streamKoe === 'function'
  } catch (error) {
    trace(`[mcp-mod] sing capability probe failed: ${errorMessage(error)}\n`)
    canSing = false
  }

  if (canSing) {
    tools.push({
      name: 'sing',
      description:
        'Sing raw stackchan-voice koe notation through the speaker (koe: string, required, max 200 characters). Registered because the active TTS supports singing; if the engine is swapped after boot and no longer does, this returns a "does not support singing" error instead. koe notation looks like "#C4,450ki#C4,450ra#G4,450ki" (each "#NOTE,MILLISECONDS" token pins one kana mora to a pitch and duration; "#R,150" is a 150ms rest).',
      inputSchema: {
        type: 'object',
        properties: {
          koe: { type: 'string', description: 'stackchan-voice koe notation, max 200 characters' },
        },
        required: ['koe'],
      },
      handler: async (args) => {
        const koe = args.koe
        if (typeof koe !== 'string' || koe.length === 0)
          throw new Error('koe is required and must be a non-empty string')
        if (koe.length > KOE_MAX_LENGTH) throw new Error(`koe must be ${KOE_MAX_LENGTH} characters or fewer`)
        const result = await audio.sing(koe)
        if (result.success === false) throw new Error(result.reason)
        return `Sang: "${result.value}"`
      },
    })
  }

  return tools
}

export default audioTools
