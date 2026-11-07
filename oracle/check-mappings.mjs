// The generator's oracle: every message in the generated Pico dialects must have the id, name,
// CRC-extra, payload length and field layout that mavlink-mappings (1.0.22-20260311) ships.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mappings from 'mavlink-mappings'

const here = dirname(fileURLToPath(import.meta.url))
const MODULES = ['minimal', 'standard', 'common', 'ardupilotmega']

/** The generated MessageInfo declarations of a Pico dialect. */
function generated(module) {
  const text = readFileSync(join(here, '../src/dialects', `${module}.pi`), 'utf8')
  const out = []
  const info = /new MessageInfo\((\d+), "([^"]+)", (\d+), (\d+), (\d+), \[\n([\s\S]*?)\n  \]/g
  for (const m of text.matchAll(info)) {
    const fields = [...m[6].matchAll(/new MavLinkPacketField\("([^"]*)", "([^"]*)", (\d+), (true|false), (\d+), "([^"]*)", "([^"]*)"(?:, (\d+))?\)/g)]
      .map(f => ({ source: f[1], name: f[2], offset: +f[3], extension: f[4] === 'true', size: +f[5], type: f[6], units: f[7], length: +(f[8] ?? 0) }))
    out.push({ id: +m[1], name: m[2], payloadLength: +m[3], base: +m[4], magic: +m[5], fields })
  }
  return out
}

let problems = 0
let checked = 0
const fail = msg => { problems++; if (problems <= 20) console.log(msg) }
for (const module of MODULES) {
  const registry = mappings[module].REGISTRY
  const ours = generated(module)
  const theirIds = Object.keys(registry).map(Number)
  if (ours.length !== theirIds.length) fail(`${module}: ${ours.length} messages, mavlink-mappings has ${theirIds.length}`)
  for (const m of ours) {
    const clazz = registry[m.id]
    if (!clazz) { fail(`${module}: ${m.name} (${m.id}) isn't in mavlink-mappings`); continue }
    checked++
    const want = { name: clazz.MSG_NAME, payloadLength: clazz.PAYLOAD_LENGTH, magic: clazz.MAGIC_NUMBER }
    for (const k of Object.keys(want)) if (m[k] !== want[k]) fail(`${m.name}: ${k} ${m[k]}, mavlink-mappings ${want[k]}`)
    if (mappings.MSG_ID_MAGIC_NUMBER[m.id] !== m.magic) fail(`${m.name}: magic ${m.magic}, MSG_ID_MAGIC_NUMBER ${mappings.MSG_ID_MAGIC_NUMBER[m.id]}`)
    const base = clazz.FIELDS.filter(f => !f.extension).reduce((a, f) => a + (f.length || 1) * f.size, 0)
    if (m.base !== base) fail(`${m.name}: base length ${m.base}, mavlink-mappings ${base}`)
    if (m.fields.length !== clazz.FIELDS.length) { fail(`${m.name}: ${m.fields.length} fields, mavlink-mappings ${clazz.FIELDS.length}`); continue }
    m.fields.forEach((f, i) => {
      const g = clazz.FIELDS[i]
      for (const k of ['source', 'name', 'offset', 'extension', 'size', 'type', 'units', 'length']) {
        if (f[k] !== g[k]) fail(`${m.name}.${f.source}: ${k} ${JSON.stringify(f[k])}, mavlink-mappings ${JSON.stringify(g[k])}`)
      }
    })
  }
}
console.log(`${checked} messages checked, ${problems} differences`)
process.exit(problems ? 1 : 0)
