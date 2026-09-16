/*
 * Microphone input gain (ES7210 audio ADC, I2C 0x40).
 *
 * The CoreS3's mics feed an ES7210, whose per-channel PGA lives in MIC1_GAIN (0x43) and MIC2_GAIN (0x44).
 * The Moddable target's setup writes 0x1B to both: bit 4 selects the differential mic input, and gain
 * code 0x0B is 33 dB. The maximum is code 14 at 37.5 dB, so the whole unused analog range is 4.5 dB -
 * far less than the ~30 dB these recordings are short by, which means the PGA is not the main cause.
 *
 * The firmware keeps its own I2C client for this chip (globalThis.mic) with a private handle, so this
 * opens a second client at the same address. The I2C layer refuses that for a device already open
 * ("duplicate address"), so the tools report plainly when the chip cannot be reached.
 */
const ES7210_ADDRESS = 0x40
const MIC1_GAIN = 0x43
const MIC2_GAIN = 0x44
// Bit 4 of MIC1/2_GAIN is SELMIC1/SELMIC2 (select the differential mic input), not a gain enable.
const SELECT_MIC_BIT = 0x10
// ES7210 datasheet rev 21.0, register 0x43: 3 dB per step up to code 11, then 1.5 dB.
const GAIN_DB = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 34.5, 36, 37.5]
const MAX_GAIN_CODE = 0x0e
const DEFAULT_FIRMWARE_CODE = 0x0b

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function decibelsFor(code) {
  return GAIN_DB[code] ?? GAIN_DB[GAIN_DB.length - 1]
}

function openES7210() {
  const internal = globalThis.device?.I2C?.internal
  const SMBus = globalThis.device?.io?.SMBus
  if (!internal || !SMBus) throw new Error('this platform does not expose an internal I2C bus to MODs')
  return new SMBus({ ...internal, io: SMBus, address: ES7210_ADDRESS, hz: 400_000 })
}

function withES7210(action) {
  let io
  try {
    io = openES7210()
    return action(io)
  } catch (error) {
    const message = errorMessage(error)
    if (message.toLowerCase().includes('duplicate')) {
      throw new Error(
        'the firmware already holds the ES7210 audio ADC open, and the I2C layer refuses a second client at the same address, so mic gain cannot be changed from a MOD on this firmware',
      )
    }
    throw new Error(`could not reach the ES7210 audio ADC: ${message}`)
  } finally {
    try {
      io?.close?.()
    } catch (closeError) {
      trace(`[mcp-mod] mic gain: close failed: ${errorMessage(closeError)}\n`)
    }
  }
}

export function micGainTools() {
  // Probe once: on this firmware the ES7210 is already open and a second client is refused, so the
  // tools would only ever return an error. Omit them rather than advertise a tool that cannot work.
  try {
    const io = openES7210()
    io?.close?.()
  } catch (error) {
    trace(`[mcp-mod] mic gain unavailable: ${errorMessage(error)}\n`)
    return []
  }

  return [
    {
      name: 'get_mic_gain',
      description:
        'Read the microphone preamp gain from the ES7210 audio ADC (registers MIC1_GAIN/MIC2_GAIN). Reports the gain code and its value in dB.',
      inputSchema: { type: 'object', properties: {} },
      handler: () =>
        withES7210((io) => {
          const mic1 = io.readUint8(MIC1_GAIN)
          const mic2 = io.readUint8(MIC2_GAIN)
          const code1 = mic1 & 0x0f
          const code2 = mic2 & 0x0f
          return (
            `MIC1_GAIN: 0x${mic1.toString(16)} (code ${code1}, about ${decibelsFor(code1)} dB)\n` +
            `MIC2_GAIN: 0x${mic2.toString(16)} (code ${code2}, about ${decibelsFor(code2)} dB)\n` +
            `The firmware sets code ${DEFAULT_FIRMWARE_CODE} (${decibelsFor(DEFAULT_FIRMWARE_CODE)} dB) at boot; the maximum is code ${MAX_GAIN_CODE} (${decibelsFor(MAX_GAIN_CODE)} dB), so only ${(decibelsFor(MAX_GAIN_CODE) - decibelsFor(DEFAULT_FIRMWARE_CODE)).toFixed(1)} dB more is available from this register.`
          )
        }),
    },
    {
      name: 'set_mic_gain',
      description:
        'Set the microphone preamp gain on the ES7210 audio ADC. gain_code is 0..14: 3 dB per step up to code 11 (33 dB), then 1.5 dB steps to code 14 (37.5 dB). The firmware default is 11, so at most 4.5 dB more is available. Higher gain raises quiet speech but also the noise floor, and too high will clip. The change lasts until the robot reboots.',
      inputSchema: {
        type: 'object',
        properties: {
          gain_code: {
            type: 'integer',
            description:
              'Gain code 0..14 (3 dB per step to code 11 = 33 dB, then 1.5 dB steps to 37.5 dB); firmware default 11',
          },
        },
        required: ['gain_code'],
      },
      handler: (args) => {
        if (typeof args.gain_code !== 'number' || !Number.isFinite(args.gain_code)) {
          throw new Error('gain_code is required and must be a number 0..14')
        }
        const code = Math.max(0, Math.min(MAX_GAIN_CODE, Math.trunc(args.gain_code)))
        const value = SELECT_MIC_BIT | code
        return withES7210((io) => {
          io.writeUint8(MIC1_GAIN, value)
          io.writeUint8(MIC2_GAIN, value)
          let readback = ''
          try {
            readback = ` Read back MIC1_GAIN 0x${io.readUint8(MIC1_GAIN).toString(16)}, MIC2_GAIN 0x${io
              .readUint8(MIC2_GAIN)
              .toString(16)}.`
          } catch (error) {
            trace(`[mcp-mod] mic gain: readback failed: ${errorMessage(error)}\n`)
          }
          return `Mic gain set to code ${code} (${decibelsFor(code)} dB) on both channels.${readback} Lasts until reboot.`
        })
      },
    },
  ]
}

export default micGainTools
