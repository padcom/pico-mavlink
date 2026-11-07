// Generates src/dialects/*.pi from the MAVLink XML, with mavlink-mappings-gen's data model (names,
// field order, offsets, CRC-extra are computed by the owner's generator; only the output is Pico).
//
//   node generate.mjs [path to a mavlink-mappings checkout]   (default: ../../../mavlink-mappings)
//
// The XML isn't vendored (mavlink/mavlink is LGPL-3.0; its generated output is MIT by the
// project's exception). The inputs are pinned by SHA-256: a different file is refused.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import datasource from 'mavlink-mappings-gen/dist/generator/datasource.js'
import codeUtils from 'mavlink-mappings-gen/dist/generator/code-utils.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = process.argv[2] ?? join(here, '../../../mavlink-mappings')
const out = join(here, '../src/dialects')

/** The inputs: mavlink-mappings 1.0.22-20260311's XML. Order matters: later modules may extend earlier ones. */
export const MODULES = [
  { name: 'minimal', sha256: '7bbf84456396089cf4dd9661ebe94e48a81009c047e826ed2778b4b9be60145c' },
  { name: 'standard', sha256: '1c92c50e0a4d4cc29e4125dff33b16062e1e285a6271292fb3a4266576487e65' },
  { name: 'common', sha256: 'acb09a8405f5201b64df087dbc5564e7c475c78c3659dd84cf4ac0c640cd830d' },
  { name: 'ardupilotmega', sha256: '627c4f35c87133cd205ce4cbc5b0a7bac780bc9b203ba5dc816f1d0ffd50e4b4' },
]

/** Names mavlink-mappings-gen fixes by hand (their XML names lack an underscore). */
const FIXED_MESSAGE_NAMES = {
  111: 'TimeSync', 138: 'MotionCaptureAttPos', 152: 'MemInfo', 164: 'SimState',
  165: 'HwStatus', 173: 'RangeFinder', 177: 'CompassMotStatus', 253: 'StatusText',
}

const PICO_TYPE = {
  char: 'u8', int8_t: 'i8', uint8_t: 'u8', uint8_t_mavlink_version: 'u8',
  int16_t: 'i16', uint16_t: 'u16', int32_t: 'i32', uint32_t: 'u32',
  int64_t: 'i64', uint64_t: 'u64', float: 'f32', double: 'f64',
}

const READ = {
  u8: 'readU8', i8: 'readI8', u16: 'readU16', i16: 'readI16', u32: 'readU32', i32: 'readI32',
  u64: 'readU64', i64: 'readI64', f32: 'readF32', f64: 'readF64',
}

/** A Pico statement writing `value` (of Pico type `t`, `size` bytes) at `at`. */
function write(t, size, at, value) {
  switch (t) {
    case 'u64': return `writeU64(into, ${at}, ${value})`
    case 'f32': return `writeF32(into, ${at}, ${value})`
    case 'f64': return `writeF64(into, ${at}, ${value})`
    case 'i64': return `writeUint(into, ${at}, 8, ${value})`
    default: return `writeUint(into, ${at}, ${size}, ${value} as int)`
  }
}

/** Text as `///` doc lines (at `indent`), wrapped at 100 columns as mavlink-mappings does. */
function doc(text, indent = '') {
  const lines = codeUtils.matchTextToWidth(String(text ?? '').replace(/\s+/g, ' ').trim())
  return lines.map(l => `${indent}/// ${l}`.trimEnd())
}

const quote = s => JSON.stringify(s)

/** Pico takes keywords as member names (as TypeScript does) except `operator`. */
const RESERVED = new Set(['operator'])
export const fieldName = name => RESERVED.has(name) ? `${name}_` : name

function enumCode(e) {
  const lines = ['', ...doc(e.description || e.source.name), `export class ${e.name} {`]
  e.values.forEach((v, i) => {
    if (i > 0) lines.push('')
    lines.push(...doc(v.description, '  '))
    lines.push(`  public static readonly ${v.name}: int = ${v.value}`)
  })
  lines.push('')
  lines.push(`  /// The name of \`value\` (\`${e.values[0]?.name ?? ''}\` …), or null for a value this dialect doesn't define.`)
  lines.push('  public static nameOf(value: int): string? {')
  lines.push('    match (value) {')
  const seen = new Set()
  for (const v of e.values) {
    if (seen.has(String(v.value))) continue
    seen.add(String(v.value))
    lines.push(`      ${v.value} => ${quote(v.name)},`)
  }
  lines.push('      _ => null,')
  lines.push('    }')
  lines.push('  }')
  lines.push('}')
  return lines
}

/** The message's fields in wire order with their offsets (as generateMessageDefinitionFields lays them out). */
export function layout(fields) {
  const sorted = [...fields]
  sorted.sort((a, b) => b.fieldSize - a.fieldSize)
  let offset = 0
  const placed = []
  for (const f of [...sorted.filter(f => !f.extension), ...fields.filter(f => f.extension)]) {
    placed.push({ ...f, offset })
    offset += f.size
  }
  return placed
}

function messageCode(m) {
  const name = FIXED_MESSAGE_NAMES[m.id] ?? m.name
  const placed = layout(m.fields)
  const base = m.fields.filter(f => !f.extension).reduce((a, f) => a + f.size, 0)
  const lines = ['', ...doc(m.description || m.source.name)]
  if (m.deprecated) {
    lines.push('///')
    lines.push(`/// Deprecated since ${m.deprecated.since ?? 'unknown'}, replaced by ${m.deprecated.replacedBy ?? 'unknown'}.`)
  }
  lines.push(`export class ${name} extends MavLinkData {`)
  lines.push(`  public static readonly MSG_ID: int = ${m.id}`)
  lines.push(`  public static readonly MSG_NAME: string = ${quote(m.source.name)}`)
  lines.push(`  public static readonly PAYLOAD_LENGTH: int = ${m.payloadLength}`)
  lines.push(`  public static readonly MAGIC_NUMBER: int = ${m.magic}`)
  lines.push(`  public static readonly INFO: MessageInfo = new MessageInfo(${m.id}, ${quote(m.source.name)}, ${m.payloadLength}, ${base}, ${m.magic}, [`)
  for (const f of placed) {
    const length = f.arrayLength ? `, ${f.arrayLength}` : ''
    lines.push(`    new MavLinkPacketField(${quote(f.source.name)}, ${quote(f.name)}, ${f.offset}, ${f.extension}, ${f.fieldSize}, ${quote(f.fieldType)}, ${quote(f.units)}${length}),`)
  }
  lines.push(`  ], (p) => ${name}.decode(p))`)
  // Fields, in the XML's order (as mavlink-mappings declares them).
  for (const f of m.fields) {
    lines.push('')
    lines.push(...doc(f.description, '  '))
    const notes = [f.source.enum ? `Values: \`${codeUtils.makeClassName(f.source.enum)}\`.` : '', f.units ? `Units: ${f.units}.` : '']
      .filter(Boolean).join(' ')
    if (notes) lines.push(`  /// ${notes}`)
    lines.push(`  public ${fieldName(f.name)}: ${fieldType(f)} = ${initial(f)}`)
  }
  lines.push('')
  lines.push(`  /// A ${m.source.name} from \`payload\` (zeros past its end).`)
  lines.push(`  public static decode(payload: Uint8Array): ${name} {`)
  lines.push(`    const m = new ${name}()`)
  for (const f of placed) lines.push(...decodeField(f))
  lines.push('    m')
  lines.push('  }')
  lines.push('')
  lines.push('  public override encode(into: Uint8Array, at: int): void {')
  for (const f of placed) lines.push(...encodeField(f))
  lines.push('  }')
  lines.push('')
  lines.push(`  public override info(): MessageInfo {`)
  lines.push(`    ${name}.INFO`)
  lines.push('  }')
  lines.push('}')
  return { name, lines }
}

const isText = f => f.arrayLength && f.source.type.startsWith('char[')

function fieldType(f) {
  if (isText(f)) return 'string'
  const t = PICO_TYPE[f.itemType]
  return f.arrayLength ? `${t}[]` : t
}

function initial(f) {
  if (isText(f)) return '""'
  if (f.arrayLength) return '[]'
  const t = PICO_TYPE[f.itemType]
  return t === 'f32' || t === 'f64' ? '0.0' : '0'
}

function decodeField(f) {
  const n = fieldName(f.name)
  if (isText(f)) return [`    m.${n} = readChars(payload, ${f.offset}, ${f.arrayLength})`]
  const t = PICO_TYPE[f.itemType]
  if (f.arrayLength) {
    return [`    for (let i = 0; i < ${f.arrayLength}; i++) {`,
      `      m.${n}.push(${READ[t]}(payload, ${f.offset} + i * ${f.fieldSize}))`,
      '    }']
  }
  return [`    m.${n} = ${READ[t]}(payload, ${f.offset})`]
}

function encodeField(f) {
  const n = fieldName(f.name)
  if (isText(f)) return [`    writeChars(into, at + ${f.offset}, ${f.arrayLength}, this.${n})`]
  const t = PICO_TYPE[f.itemType]
  if (f.arrayLength) {
    return [`    for (let i = 0; i < ${f.arrayLength} && i < this.${n}.length; i++) {`,
      `      ${write(t, f.fieldSize, `at + ${f.offset} + i * ${f.fieldSize}`, `this.${n}[i]`)}`,
      '    }']
  }
  return [`    ${write(t, f.fieldSize, `at + ${f.offset}`, `this.${n}`)}`]
}

function header(module) {
  return [
    `// The ${module} dialect: generated by pico-mavlink's generator from ${module}.xml`,
    '// (mavlink-mappings 1.0.22-20260311). Don\'t edit: run `npm run generate` in generator/.',
    '// MAVLink generator output is MIT-licensed under the mavlink/mavlink exception.',
  ]
}

async function main() {
  mkdirSync(out, { recursive: true })
  const magic = []
  for (const module of MODULES) {
    const xml = readFileSync(join(source, `${module.name}.xml`))
    const sha = createHash('sha256').update(xml).digest('hex')
    if (sha !== module.sha256) {
      throw new Error(`${module.name}.xml in ${source} isn't the pinned input (sha256 ${sha})`)
    }
    const { enumDefs, messageDefs } = await new datasource.XmlDataSource().parse(xml.toString())
    const lines = [...header(module.name)]
    const messages = [...messageDefs]
    const body = []
    for (const e of [...enumDefs]) body.push(...enumCode(e))
    const names = []
    for (const m of messages) {
      const { name, lines: code } = messageCode(m)
      names.push([m.id, name])
      body.push(...code)
      magic.push([m.id, m.magic])
    }
    // Import only what the code uses (an unused import is a lint warning).
    const text = body.join('\n')
    const used = names => names.filter(n => new RegExp(`\\b${n}\\(`).test(text))
    const data = messages.length > 0 ? ['MavLinkData', 'MavLinkPacketField', 'MessageInfo'] : ['MessageInfo']
    lines.push(`import { ${data.join(', ')} } from "../data"`)
    const bytes = used(['readChars', 'readF32', 'readF64', 'readI16', 'readI32', 'readI64', 'readI8', 'readU16', 'readU32',
      'readU64', 'readU8', 'writeChars', 'writeF32', 'writeF64', 'writeU64', 'writeUint'])
    if (bytes.length > 0) lines.push(`import { ${bytes.join(', ')} } from "../bytes"`)
    lines.push(...body)
    lines.push('')
    lines.push(`/// The ${module.name} dialect's own messages by id (merge its includes with \`Registry\`).`)
    lines.push('export const REGISTRY: Map<int, MessageInfo> = new Map<int, MessageInfo>()')
    for (const [, name] of names) lines.push(`REGISTRY.set(${name}.MSG_ID, ${name}.INFO)`)
    writeFileSync(join(out, `${module.name}.pi`), lines.join('\n') + '\n')
    console.log(`${module.name}: ${enumDefs.length} enums, ${messages.length} messages`)
  }
  const m = [
    '// CRC-extra by message id for every generated dialect (mavlink-mappings\' MSG_ID_MAGIC_NUMBER).',
    '// Generated: don\'t edit.',
    '',
    '/// CRC-extra by message id.',
    'export const MSG_ID_MAGIC_NUMBER: Map<int, int> = new Map<int, int>()',
    ...magic.map(([id, mg]) => `MSG_ID_MAGIC_NUMBER.set(${id}, ${mg})`),
  ]
  writeFileSync(join(out, 'magic-numbers.pi'), m.join('\n') + '\n')
}

main().catch(e => { console.error(e.message); process.exit(1) })
