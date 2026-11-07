// node-mavlink's splitter over a capture: valid/invalid/unknown counts (the oracle for spike/).
import { createReadStream } from 'node:fs'
import { MavLinkPacketSplitter } from 'node-mavlink'

const file = process.argv[2]
const splitter = new MavLinkPacketSplitter()
let packets = 0
splitter.on('data', () => { packets++ })
splitter.on('end', () => {
  console.log(`${packets} ${splitter.validPackages}/${splitter.invalidPackages}/${splitter.unknownPackagesCount}`)
})
createReadStream(file).pipe(splitter)
