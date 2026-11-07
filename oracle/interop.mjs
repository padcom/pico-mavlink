// Generates src/interop.test.pi: for every message of the generated dialects, seeded random field
// values go through node-mavlink 2.3.0 (v1, v2 and signed v2 frames); the Pico test builds the same
// message and must produce the same bytes, and must decode node-mavlink's v2 frame back to the
// same values. Expected difference (docs/design.md §3.4): node-mavlink's v1 frames carry
// extension fields, Pico's carry the base payload only; for those messages the test checks that
// the Pico frame is node-mavlink's without the extensions, with its own length and CRC.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mappings from 'mavlink-mappings'
import { MavLinkProtocolV1, MavLinkProtocolV2, MavLinkPacketSignature } from 'node-mavlink'

const here = dirname(fileURLToPath(import.meta.url))
const MODULES = ['minimal', 'standard', 'common', 'ardupilotmega']
const KEY_PASSPHRASE = 'pico-mavlink'
const TIMESTAMP = 1_700_000_000_000

// A small deterministic PRNG (mulberry32), so the fixtures are the same every time.
let seed = 0x5EED
function rand() {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))

const RANGES = {
  char: [0, 127], int8_t: [-128, 127], uint8_t: [0, 255], uint8_t_mavlink_version: [0, 255],
  int16_t: [-32768, 32767], uint16_t: [0, 65535], int32_t: [-2147483648, 2147483647], uint32_t: [0, 4294967295],
}
const TEXT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'

function value(type) {
  switch (type) {
    case 'int64_t': return BigInt(int(-(2 ** 31), 2 ** 31)) * BigInt(int(1, 2 ** 20))
    case 'uint64_t': return BigInt(int(0, 2 ** 31)) * BigInt(int(1, 2 ** 20))
    case 'float': return Math.fround(int(-1_000_000, 1_000_000) / 1000)
    case 'double': return int(-1_000_000_000, 1_000_000_000) / 10_000
    default: return int(...RANGES[type])
  }
}

function fieldValue(f) {
  const item = f.type.replace('[]', '')
  if (f.type === 'char[]') {
    const n = int(0, f.length)
    let s = ''
    for (let i = 0; i < n; i++) s += TEXT[int(0, TEXT.length - 1)]
    return s
  }
  if (f.length) return Array.from({ length: f.length }, () => value(item))
  return value(item)
}

/** A Pico literal of `v` for wire type `item`. */
function lit(v, item) {
  if (item === 'float') return `(${v}) as f32`
  if (item === 'double') return `(${v}) as f64`
  return `${v}`
}

const PICO = {
  char: 'u8', int8_t: 'i8', uint8_t: 'u8', uint8_t_mavlink_version: 'u8', int16_t: 'i16', uint16_t: 'u16',
  int32_t: 'i32', uint32_t: 'u32', int64_t: 'i64', uint64_t: 'u64', float: 'f32', double: 'f64',
}

/** Pico class names by message id, from the generated dialects. */
function classes(module) {
  const text = readFileSync(join(here, '../src/dialects', `${module}.pi`), 'utf8')
  const out = new Map()
  for (const m of text.matchAll(/export class (\w+) extends MavLinkData \{\n {2}public static readonly MSG_ID: int = (\d+)/g)) {
    out.set(+m[2], m[1])
  }
  return out
}

const hex = b => Buffer.from(b).toString('hex')
const key = MavLinkPacketSignature.key(KEY_PASSPHRASE)
const imports = []
const cases = []
let n = 0
const taken = new Set()
for (const module of MODULES) {
  const names = classes(module)
  const used = []
  for (const [id, clazz] of Object.entries(mappings[module].REGISTRY)) {
    const local = names.get(+id)
    if (!local) throw new Error(`${module}: no Pico class for ${id}`)
    // Two dialects may name a class alike (SimState is SIM_STATE in common, SIMSTATE in
    // ardupilotmega): the later one is imported under an alias.
    const name = taken.has(local) ? `${module[0].toUpperCase()}${module.slice(1)}${local}` : local
    taken.add(name)
    used.push(name === local ? local : `${local} as ${name}`)
    const msg = new clazz()
    const sets = []
    const checks = []
    for (const f of clazz.FIELDS) {
      const v = fieldValue(f)
      msg[f.name] = v
      const item = f.type.replace('[]', '')
      if (f.type === 'char[]') {
        sets.push(`  m.${f.name} = ${JSON.stringify(v)}`)
        checks.push(`  expect(d.${f.name}).toBe(${JSON.stringify(v)})`)
      } else if (f.length) {
        sets.push(`  m.${f.name} = [${v.map(x => lit(x, item)).join(', ')}]`)
        v.forEach((x, i) => checks.push(`  expect(\`${f.name}[${i}] \${d.${f.name}[${i}] == ${lit(x, item)}}\`).toBe("${f.name}[${i}] true")`))
      } else {
        sets.push(`  m.${f.name} = ${lit(v, item)}`)
        checks.push(`  expect(\`${f.name} \${d.${f.name} == ${lit(v, item)}}\`).toBe("${f.name} true")`)
      }
    }
    const seq = int(0, 255)
    const v2 = new MavLinkProtocolV2(int(1, 255), int(1, 255)).serialize(msg, seq)
    const v2h = [v2[5], v2[6]]
    const signer = new MavLinkProtocolV2(v2h[0], v2h[1], MavLinkProtocolV2.IFLAG_SIGNED)
    const signed = signer.sign(signer.serialize(msg, seq), 7, key, TIMESTAMP)
    const hasExt = clazz.FIELDS.some(f => f.extension)
    let v1 = null
    if (+id <= 255) {
      v1 = new MavLinkProtocolV1(v2h[0], v2h[1]).serialize(msg, seq)
      if (hasExt) {
        // The frame Pico sends: node-mavlink's, cut to the base payload, its length and CRC redone.
        const base = clazz.FIELDS.filter(f => !f.extension).reduce((a, f) => a + (f.length || 1) * f.size, 0)
        const frame = Buffer.alloc(6 + base + 2)
        v1.copy(frame, 0, 0, 6 + base)
        frame[1] = base
        frame.writeUInt16LE(mappings.x25crc(frame, 1, 2, clazz.MAGIC_NUMBER), 6 + base)
        v1 = frame
      }
    }
    const fn = `case${n++}`
    cases.push(`
/// ${clazz.MSG_NAME} (${module}, id ${id})
function ${fn}(): void throws Error {
  const m = new ${name}()
${sets.join('\n')}
  expect(hex(new MavLinkProtocolV2(${v2h[0]}, ${v2h[1]}).serialize(m, ${seq}))).toBe("${hex(v2)}")
  const signer = new MavLinkProtocolV2(${v2h[0]}, ${v2h[1]}, MavLinkProtocolV2.IFLAG_SIGNED)
  expect(hex(signer.sign(signer.serialize(m, ${seq}), 7, KEY, ${TIMESTAMP}))).toBe("${hex(signed)}")
${v1 ? `${hasExt ? '  // v1: node-mavlink\'s frame without the extension fields (docs/design.md §3.4)\n' : ''}  expect(hex(new MavLinkProtocolV1(${v2h[0]}, ${v2h[1]}).serialize(m, ${seq}))).toBe("${hex(v1)}")` : '  // v1: an id above 255 doesn\'t fit (refused)'}
  const d = ${name}.decode(new MavLinkPacketParser().parse(unhex("${hex(v2)}")).payload)
${checks.join('\n')}
}`)
  }
  imports.push(`import { ${used.join(', ')} } from "./dialects/${module}"`)
}

const out = `// Generated by oracle/interop.mjs from node-mavlink 2.3.0 and mavlink-mappings 1.0.22-20260311:
// ${n} messages with seeded random values, as node-mavlink frames them (v1, v2, signed v2) and as Pico
// MAVLink must. Don't edit: run \`npm run interop\` in oracle/.
import { describe, it, expect } from "std/test"
import { MavLinkPacketParser, MavLinkPacketSignature, MavLinkProtocolV1, MavLinkProtocolV2 } from "./protocol"
${imports.join('\n')}

const KEY = MavLinkPacketSignature.key(${JSON.stringify(KEY_PASSPHRASE)})

function hex(b: Uint8Array): string {
  const digits = "0123456789abcdef"
  let s = ""
  for (let i = 0; i < b.length; i++) {
    s += \`\${digits[b[i] >> 4]}\${digits[b[i] & 0xF]}\`
  }
  s
}

function nibble(s: string, i: int): int {
  "0123456789abcdef".indexOf(s.slice(i, i + 1))
}

function unhex(s: string): Uint8Array {
  const b = new Uint8Array(s.length / 2)
  for (let i = 0; i < b.length; i++) {
    b.set(i, nibble(s, i * 2) * 16 + nibble(s, i * 2 + 1))
  }
  b
}
${cases.join('\n')}

describe("interop with node-mavlink 2.3.0", () => {
${cases.map((_, i) => `  it("case ${i}", case${i})`).join('\n')}
})
`
writeFileSync(join(here, '../src/interop.test.pi'), out)
console.log(`${n} messages`)
