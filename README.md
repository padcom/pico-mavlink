# pico-mavlink

Native MAVLink 1 and 2 for [Pico](https://github.com/padcom/pico-lang), modelled on
[node-mavlink](https://github.com/ArduPilot/node-mavlink) and
[mavlink-mappings](https://github.com/ArduPilot/node-mavlink-mappings).

Status: **in development (MV1).**
- **Done:** the byte layer, the generated `minimal`, `standard`, `common` and `ardupilotmega`
  dialects (checked against mavlink-mappings), and a framing spike that splits node-mavlink's
  3412-packet capture exactly as node-mavlink does.
- **Done:** the splitter (bounded buffer, tlog), the parser, MAVLink 1 and 2 protocols,
  and signing. 296 interop cases, one per message, check that Pico MAVLink frames byte for byte
  as node-mavlink 2.3.0 does (v2, signed v2, v1), and decodes node-mavlink's frames to the same
  values.
- **Done:** `packets(stream)`, `MavLinkConnection` (send, sendSigned, decoded `messages()`), and
  byte streams over UDP, TCP, files and an in-memory pipe.
- **Done:** typed parameter values (bytewise and C-cast, nothing silently made a float) and the
  operations: `HeartbeatSender`, `VehicleDiscovery`, `ParamList` (asks again for what went
  missing, and says when a list stays incomplete), `ParamRead`, and `ParamWrite` (verifies the
  read-back; a changed value is reported, never taken as success). They're tested against a
  simulated autopilot.
- **Done:** a signing policy for received packets: signatures checked, replays rejected per
  system, component and link, and unsigned packets accepted, accepted for listed messages, or
  rejected.
- **Done:** `SimulatedAutopilot`, an ArduPilot Copter-like vehicle on the far end of any byte
  stream. It sends heartbeats and telemetry and answers parameter requests, with deterministic
  data, for trying an application without hardware or SITL.
- **Next:** ArduPilot SITL over UDP/TCP (MV2).

```pico
import { bind } from "std/net"
import { Heartbeat, MavLinkConnection, MavType, UdpStream } from "padcom/pico-mavlink"

const conn = new MavLinkConnection(new UdpStream(await bind(14550)))   // SITL's UDP out
for await (const r of conn.messages()) {
  const m = r.message
  if (m instanceof Heartbeat) {
    println(`heartbeat from ${r.packet.header.sysid}: ${MavType.nameOf(m.type) ?? "?"}`)
  }
}
```

Two dialects share some class names: ardupilotmega's `SIMSTATE` and its `MAV_CMD` additions
clash with common's. The package exports the later ones with the dialect's name as a prefix
(`ArdupilotmegaSimState`, `ArdupilotmegaMavCmd`).

The tests narrow decoded messages with `instanceof`, which needs pico-lang PR
[#103](https://github.com/padcom/pico-lang/pull/103) (#102). Until it's released, use a pico
built with it; pico 0.4.2 has everything else.

The design is in [docs/design.md](docs/design.md).

## Development

```sh
(cd generator && npm install) && (cd oracle && npm install)
scripts/check.sh            # regenerate + diff, oracles, fmt/lint, tests
```

The generator reads the MAVLink XML from a `mavlink-mappings` checkout (`MAPPINGS=…`, default
`../../mavlink-mappings`). The XML isn't part of this repository.

## License

MIT. The generated dialects are MAVLink generator output, which is MIT under the mavlink/mavlink exception.
