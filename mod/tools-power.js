/*
 * Read-only AXP2101 diagnostics.
 *
 * The host's `axp2101-power-capture` module monkey-patches AXP2101 read/write to keep a reference to the
 * instance the platform setup created, and hands it back through getAxp2101Power(). That avoids opening a
 * second I2C client at the same address, which the I2C layer refuses ("duplicate address").
 *
 * These tools only READ. A wrong write to a PMIC can damage hardware, so register writes are deliberately
 * not exposed here.
 */
import { getAxp2101Power } from 'axp2101-power-capture'

// Registers the CoreS3 platform setup touches, plus the status/fault registers that explain a rail being off.
// Expectations come from host/platforms/m5stackchan_cores3/setup-target.js and the Moddable target setup.
const REGISTERS = [
  { address: 0x00, name: 'PMU status 1' },
  { address: 0x01, name: 'PMU status 2' },
  { address: 0x27, name: 'PWROFF/PWRON config', expected: 0x00 },
  { address: 0x30, name: 'ADC enable', expected: 0x3f },
  // IRQ status 0/1/2 in datasheet numbering. Most bits are ordinary events (charge start/done, SOC
  // warning, watchdog), not faults, and nothing clears them, so they accumulate - diff against a
  // known-good baseline rather than reading a set bit as a problem.
  { address: 0x48, name: 'IRQ status 0' },
  { address: 0x49, name: 'IRQ status 1' },
  { address: 0x4a, name: 'IRQ status 2' },
  { address: 0x62, name: 'charge current' },
  { address: 0x69, name: 'CHGLED setting and control' },
  { address: 0x80, name: 'DCDC enable' },
  { address: 0x90, name: 'LDO enable mask', expected: 0xbf },
  { address: 0x92, name: 'ALDO1 voltage' },
  { address: 0x93, name: 'ALDO2 voltage' },
  { address: 0x94, name: 'ALDO3 voltage' },
  { address: 0x95, name: 'ALDO4 voltage' },
  { address: 0x96, name: 'BLDO1 voltage' },
  { address: 0x97, name: 'BLDO2 voltage' },
]

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function hex(value) {
  return `0x${value.toString(16).padStart(2, '0')}`
}

function binary(value) {
  return value.toString(2).padStart(8, '0')
}

export function powerTools() {
  const power = getAxp2101Power()
  if (!power || typeof power.readByte !== 'function') return []

  return [
    {
      name: 'get_power_registers',
      description:
        'Read the power chip (AXP2101) registers that control the board rails, plus its status and fault bits. Read-only diagnostic for problems like a dead display; flags any register that differs from what the firmware sets at boot.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        const lines = []
        for (const register of REGISTERS) {
          let text
          try {
            const value = power.readByte(register.address)
            text = `${hex(register.address)} ${register.name}: ${hex(value)} (${binary(value)})`
            if (register.expected !== undefined && value !== register.expected) {
              text += ` <-- expected ${hex(register.expected)}`
            }
          } catch (error) {
            text = `${hex(register.address)} ${register.name}: read failed (${errorMessage(error)})`
          }
          lines.push(text)
        }
        lines.push(
          'LDO enable mask bits are ALDO1..4, then BLDO1..2, then CPUSLDO (bit 6) and DLDO1 (bit 7); 0xbf is everything except CPUSLDO. A display rail reading disabled would explain a dark panel that survives a CPU reset.',
        )
        return lines.join('\n')
      },
    },
  ]
}

export default powerTools
