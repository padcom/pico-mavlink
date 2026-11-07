// node-mavlink's splitter over a capture: valid/invalid/unknown counts (the oracle for spike/).
import { createReadStream } from 'node:fs'
import { MavLinkPacketSplitter, MavLinkTLogPacketSplitter } from 'node-mavlink'
import * as mappings from 'mavlink-mappings'

// The magic numbers of the dialects Pico MAVLink generates (minimal, standard, common,
// ardupilotmega), so both sides know the same messages.
const magicNumbers = {}
for (const m of ['minimal', 'standard', 'common', 'ardupilotmega']) {
  for (const [id, clazz] of Object.entries(mappings[m].REGISTRY)) magicNumbers[id] = clazz.MAGIC_NUMBER
}

const file = process.argv[2]
const splitter = file.endsWith('.tlog') ? new MavLinkTLogPacketSplitter({}, { magicNumbers }) : new MavLinkPacketSplitter({}, { magicNumbers })
let first = null
splitter.on('data', p => { if (first === null) first = p.timestamp })
let packets = 0
splitter.on('data', () => { packets++ })
splitter.on('end', () => {
  console.log(`${packets} ${splitter.validPackages}/${splitter.invalidPackages}/${splitter.unknownPackagesCount} first timestamp ${first}`)
})
createReadStream(file).pipe(splitter)
