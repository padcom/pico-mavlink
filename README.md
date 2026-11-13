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
- **Done:** the MAVLink log protocol (src/logprotocol.pi): `LogProtocolClient` lists the vehicle's logs
  (`LOG_REQUEST_LIST`/`LOG_ENTRY`, re-asking for entries that were lost), downloads one (`LOG_REQUEST_DATA`/`LOG_DATA`) into a
  sink with gaps filled, a stall chased, progress, cancellation and resume from a byte offset, and erases all logs (`LOG_ERASE`).
  The protocol has no CRC, so a download is never "verified"; it sends the ground-station heartbeat ArduPilot needs, and the vehicle
  ignores every request while armed. `SimulatedAutopilot.logs` (src/simlogs.pi) serves the same `/logs/NNNNNNNN.BIN` files as FTP
  over this protocol, with loss, stall, a dropped packet, silence and corruption as faults; `simulatedLog` makes a valid DataFlash log.
- **Done:** calibration, part 1 (src/accelcal.pi): `Calibration` asks the vehicle for the gyro (`gyro`), accelerometer (`startAccel` with an
  `AccelCalKind`: full, level, simple, accept) and RC-flag (`rcCalibrating`) calibrations with `MAV_CMD_PREFLIGHT_CALIBRATION`. In the full
  accelerometer calibration the vehicle asks the ground station, by a `COMMAND_LONG` of its own (`ACCELCAL_VEHICLE_POS`, repeated every
  second), to place it level, left, right, nose down, nose up and on its back, and ends with a success or failure code: `prompt` receives
  the next request, `confirm` answers it, `run` does the whole walk. A command that calibrates is sent once and its ack waited for
  (30 s), never sent again; `rcCalibration(work)` sets the RC flag and clears it however `work` ends. There is no cancel in the protocol. `SimulatedAutopilot.calibration`
  (src/simcal.pi) does the vehicle's side, with a failure at a chosen position, a failed gyro and silence as faults; it refuses while armed.
  The compass flow and `RC_CHANNELS` come next.
- **Done:** `TlogReader` and `TlogWriter` (src/tlog.pi): a streaming reader for a ground station's `.tlog` (an 8-byte
  big-endian microsecond timestamp and one MAVLink 1 or 2 frame per record). Bounded memory (a chunk and a record), CRC-checked
  against the dialect, resync on garbage, unknown messages skipped and counted, signed frames recognised and never verified,
  segments at a step or a jump in time, 'no date' for timestamps that cannot be real, and a cut end that is not damage; a report
  accounts for every byte. Checked against a recording of ArduPilot SITL and one that MAVProxy wrote.
- **Done:** long STATUSTEXT messages: `StatusTextAssembler` joins the chunks (by system, component
  and `id`, in any order, interleaved), and delivers one whose chunks went missing after a timeout,
  marked truncated. `StatusTextReader` does it on a connection.
- **Done:** `MavLinkRouter`: several links under one connection. It reads whole frames from each
  link, delivers a frame that arrives on two links once, learns which link reaches which system
  and component, sends a targeted message only down the links that reach its target (broadcasts
  and unheard targets go to all), and can forward between links by the MAVLink routing rules.
  Operations already match replies by target system and component, so more than one vehicle on a
  connection works.
- **Done:** `TelemetryRates`: the rate of each message, asked for in one place and held. It uses
  `MAV_CMD_SET_MESSAGE_INTERVAL`, falls back to `REQUEST_DATA_STREAM` where the vehicle refuses or does not
  answer, and asks again for everything after the vehicle reboots or comes back after a silence.
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

Parameters, with their types kept (C-cast for ArduPilot, bytewise for PX4: ask the autopilot with
`AutopilotVersionRead` and `encodingOf`):

```pico
import { MavParamType, ParamEncoding, ParamList, ParamWrite, TypedParamValue, showParam } from "padcom/pico-mavlink"

conn.run()   // hands every message to the operations
const target = { system: 1, component: 1 }
const list = await new ParamList(conn, target, ParamEncoding.CCast).run()
println(`${list.params.length} of ${list.count}${if (list.complete) "" else ", some missing"}`)

const r = await new ParamWrite(conn, target, ParamEncoding.CCast).run("RTL_ALT", TypedParamValue.Int(2000, MavParamType.INT32))
println(if (r.verified) "written" else `the vehicle reports ${showParam(r.param.value)}`)
```

Status texts longer than the 50 bytes a STATUSTEXT carries arrive as chunks. `StatusTextReader` hands them
over whole:

```pico
conn.run()
const texts = new StatusTextReader(conn, 1000)   // gives up on a message 1 s after its last chunk
texts.onMessage((m: StatusMessage) => println(`${m.severity} ${m.text}${if (m.truncated) " [truncated]" else ""}`))
```

A message that lost a chunk is delivered with the text before the gap (`truncated`), not guessed at.

Several vehicles, or several links to one (a radio and a cable), under one connection:

```pico
const router = new MavLinkRouter({ forward: false })   // forward: true passes traffic between the links
router.addLink(new TcpStream(await connect(5760)))      // link 0
router.addLink(new UdpStream(await bind(14551)))        // link 1
const conn = new MavLinkConnection(router)
conn.run()
const first = await new ParamList(conn, { system: 1, component: 1 }, ParamEncoding.CCast).run()
const second = await new ParamList(conn, { system: 2, component: 1 }, ParamEncoding.CCast).run()
```

A link that fails to take a frame is marked down (`router.linkInfo()`) until it next delivers a frame, and a
targeted frame falls back to the other links; `write` fails with `NO_LINK` when no link takes a frame. Links are
written to together and `write` is done as soon as one has taken the frame, so a slow or stuck one does not hold
up the others; a write that no link has taken after `writeTimeoutMs` moves on to the other links, or fails. A
frame is good for `writeTimeoutMs`: a write still waiting behind a stuck one when that is up is dropped, not sent
late (a stale arm or mode change must not reach a vehicle), and a link still stuck then is marked down until it
next delivers a frame. A link with `maxWaitingWrites` writes already waiting behind a stalled one refuses more. The router sits below the connection and
does not check signatures: it learns routes from every well-formed frame, signed or not, and passes frames on
byte for byte. Put a `SigningPolicy` on the connection to refuse what is not signed.

Telemetry rates. ArduPilot sends almost nothing on a new link until it is asked, so ask, and let the manager keep
asking after the vehicle restarts:

```pico
conn.run()
const rates = new TelemetryRates(conn, { system: 1, component: 1 })
await rates.set(30, 10.0)   // ATTITUDE, 10 Hz
await rates.set(1, 2.0)     // SYS_STATUS, 2 Hz
await rates.off(74)         // VFR_HUD, off
rates.onReapplied((results) => println(`asked again for ${results.length} rates`))
```

`set` returns how the rate was asked for: `interval` (the vehicle accepted `SET_MESSAGE_INTERVAL`), `stream` (it
did not, so the message's `REQUEST_DATA_STREAM` group was asked for instead; a group has one rate, the highest any
message held in it needs, and that request is not acknowledged), or `none` (the message is in no stream). A reboot is
seen when the vehicle's `time_boot_ms` goes back, a reconnect when it was silent for `silenceMs` (5 s) and speaks
again. A vehicle that restarts without its link going down only goes on sending heartbeats, which say nothing of how
long it has been up, and forgets the very messages that would (ATTITUDE, say); so while the manager holds a rate it
asks for `SYSTEM_TIME` every `watchMs` (2 s; 0 turns this off), and its `time_boot_ms` gives the restart away; the rates are then asked for again after `settleMs`, and once more if the vehicle restarts again meanwhile
or a request fails (up to three passes). Requests go to the vehicle one at a time, because an acknowledgement names
its command and not the request. `stop()` cancels asking again, scheduled or begun, so a stopped manager cannot undo
the rates of one that replaced it. When the link itself is replaced (a SITL restarted and
connected to again), put the connection on a `MavLinkRouter` with `keepOpen: true` and add the new link to it: the
connection and the manager go on, and the manager sees the vehicle come back. Against ArduCopter SITL, rates of 10, 2
and 4 Hz for ATTITUDE, SYS_STATUS and VFR_HUD were measured at 10, 2 and 4 Hz, and again after the SITL was
restarted. `SimulatedAutopilot` honours intervals too, but its timers do not go faster than about 25 Hz.

Signing, as the sender and as the receiver:

```pico
const key = MavLinkPacketSignature.key("passphrase")
await conn.sendSigned(new Heartbeat(), key)
const strict = new MavLinkConnection(stream, { signing: new SigningPolicy(key, UnsignedPolicy.Reject) })
```

`SimulatedAutopilot` gives you a vehicle on the other end of a `MemoryStream.pair()` for tests and demos.

Two dialects share some class names: ardupilotmega's `SIMSTATE` and its `MAV_CMD` additions
clash with common's. The package exports the later ones with the dialect's name as a prefix
(`ArdupilotmegaSimState`, `ArdupilotmegaMavCmd`).

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
