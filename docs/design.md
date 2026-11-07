# Pico MAVLink: design (MV0)

Status: **draft for the owner's review.** The plan's MV0 exit is "approved Pico-native interfaces for
byte streams, frame parser/serializer, registry and individual operation classes". Everything here
is a proposal. The decisions only the owner can make are listed in [§9](#9-decisions-for-the-owner).

## 1. Source authority

The architecture follows the owner's own implementations, read at these pins:

| Source | Pin | What it gives |
|---|---|---|
| `node-mavlink` (`~/projects/padcom/node-mavlink`) | tag `2.3.0`, `6ca789c` | splitter, parser, protocols v1/v2, signing, `send`/`sendSigned`, serializers, fixtures |
| `mavlink-mappings` (`~/projects/padcom/mavlink-mappings`) | tag `1.0.22-20260311`, `d0f9a0f` | the generated style: data classes, enums, `REGISTRY`, `MSG_ID_MAGIC_NUMBER`, the XML inputs |
| `mavlink-mappings-gen` | `^0.0.9` (npm) | the generator that writes `mavlink-mappings` from the XML |

Both repositories are LGPL-3.0. The owner wrote them and can license this port as they choose
(PROJECT_DESCRIPTION §8); the choice is open (§9, D1). Code adapted from contributors to those
repositories, if any, keeps its obligations: check `git log` authors before porting a file.

The protocol XML comes from the copies `mavlink-mappings` pins (`common.xml`, `ardupilotmega.xml`,
plus `minimal.xml` and `standard.xml`, which they include). Generated code is checked in and
regenerated deterministically (§6).

## 2. How node-mavlink is built, and the Pico equivalent

node-mavlink is a pipeline of Node `Transform` streams:

```
Readable ─▶ MavLinkPacketSplitter ─▶ MavLinkPacketParser ─▶ MavLinkPacket
  (bytes)    finds STX 0xFE/0xFD,     header, payload        { header, payload, crc,
             length, CRC-extra        (padded to 255),        protocol, signature }
             check by MAGIC_NUMBER,   crc, signature
             counts valid/invalid/
             unknown
                                                          ─▶ protocol.data(payload, REGISTRY[msgid])
                                                              → typed message object
```

Sending is `send(stream, msg, protocol)`, which does `protocol.serialize(msg, seq)` and a write.
`sendSigned` adds `protocol.sign(buffer, linkId, key, timestamp)`.

Pico has no Node streams. What it has, and what pico-desktop and pico-serialport already use, is
`Promise`-returning reads and writes and `for await` over async iterators. The Pico pipeline keeps
the same stages and names, as plain classes driven by chunks:

| node-mavlink | Pico MAVLink | Change and why |
|---|---|---|
| `Readable` / `Writable` | `ByteStream` (§3.1) | a three-method interface, the same shape as `padcom/serialport`'s |
| `MavLinkPacketSplitter extends Transform` | `MavLinkPacketSplitter` with `push(chunk): RawPacket[]` | synchronous and pure, so it can be tested without I/O. Same counters (`validPackets`, `invalidPackets`, `unknownPackets`), same resynchronization rule (drop one byte on a CRC failure, a whole packet when the message is unknown), and a bounded buffer (new) |
| `MavLinkTLogPacketSplitter` | `MavLinkTLogPacketSplitter` | the same: an 8-byte big-endian µs timestamp before each packet |
| `MavLinkPacketParser extends Transform` | `MavLinkPacketParser.parse(raw): MavLinkPacket` | the same fields; `payload` is padded to the message's length, not to 255 |
| `createMavLinkStream(input)` | `packets(stream): AsyncIterator<MavLinkPacket>` | `for await (const packet of packets(port))` |
| `MavLinkProtocolV1` / `V2` | `MavLinkProtocolV1` / `V2` | the same responsibilities: `serialize`, `header`, `crc`, `payload`, `signature`, `sign` |
| `MavLinkPacketSignature` | `MavLinkPacketSignature` | the same, on `std/crypto` `digest("SHA-256", …)` |
| `protocol.data(payload, clazz)` (reflective, through `FIELDS`) | `clazz.decode(payload)` (generated) | see §4: no reflection on the hot path |
| `send` / `sendSigned` (module-global `seq`) | `MavLinkConnection.send(msg)` / `.sendSigned(msg, key)` | the sequence number belongs to the connection, not the module |
| `MavEsp8266`, `MavTCP` (EventEmitter) | UDP and TCP `ByteStream` adapters over `std/net` | the transports become byte streams like any other |

## 3. Interfaces

Sketches in Pico. Names follow node-mavlink where a counterpart exists (§9, D2).

### 3.1 Byte streams

```pico
/// Bytes in and out: a serial port, a TCP connection, a UDP peer, a file, a test double.
export interface ByteStream {
  /// The next chunk, as soon as some bytes are there; `null` at the end.
  read(): Promise<Uint8Array?, Error>
  write(bytes: Uint8Array): Promise<void, Error>
  close(): void
}
```

- It has the same shape as `padcom/serialport`'s `ByteStream`, and pico-mavlink doesn't import it.
  Pico interfaces are nominal, so a serial port gets a three-line adapter in the application. The
  plan asks for exactly that: no coupling either way.
- Adapters in this package: `UdpStream(socket, peer)` (it learns the peer from the first datagram,
  as MAVESP8266 and SITL expect), `TcpStream(conn)`, `FileStream(path)` (reads tlogs and .bin
  captures), and `MemoryStream` for tests.
- A shared micro-package (`padcom/bytestream`) is the alternative (§9, D3).

### 3.2 Framing and parsing

```pico
export struct RawPacket { bytes: Uint8Array; timestamp?: int }

export class MavLinkPacketSplitter {
  constructor(options: SplitterOptions = {})   // magicNumbers (default: the dialect's), maxBuffer (default 64 KiB)
  push(chunk: Uint8Array): RawPacket[]
  get validPackets(): int
  get invalidPackets(): int
  get unknownPackets(): int
  resetCounters(): void
}

export class MavLinkPacket {
  readonly bytes: Uint8Array
  readonly header: MavLinkPacketHeader
  readonly payload: Uint8Array
  readonly crc: int
  readonly protocol: MavLinkProtocol
  readonly signature: MavLinkPacketSignature?
  debug(): string
}

export async function* packets(stream: ByteStream, options: SplitterOptions = {}): AsyncIterator<MavLinkPacket> throws Error
```

The bounded buffer is new. node-mavlink concatenates without limit, so a stream of garbage
holding an STX byte can grow it. Here, past `maxBuffer` the oldest bytes are dropped up to the
next STX, and the drop counts as invalid.

### 3.3 Messages, dialects and the registry

```pico
/// What every generated message class provides (its static side, in a registry entry).
export struct MessageInfo {
  id: int; name: string; payloadLength: int; magic: int
  fields: MavLinkPacketField[]              // the same metadata as mavlink-mappings' FIELDS
  decode: (payload: Uint8Array) => MavLinkData
}

export abstract class MavLinkData {
  abstract info(): MessageInfo
  abstract encode(into: Uint8Array, at: int): void   // writes PAYLOAD_LENGTH bytes; v2 truncation is the protocol's job
}

export class Registry {
  constructor(...dialects: Map<int, MessageInfo>[])  // later dialects override earlier ones (ardupilotmega over common)
  get(id: int): MessageInfo?
  magic(id: int): int?
}
```

Generated code for a message (compare `mavlink-mappings` `Heartbeat`):

```pico
/// The heartbeat message shows that a system or component is present and responding. …
export class Heartbeat extends MavLinkData {
  static readonly MSG_ID = 0
  static readonly MSG_NAME = "HEARTBEAT"
  static readonly PAYLOAD_LENGTH = 9
  static readonly MAGIC_NUMBER = 50
  static readonly INFO: MessageInfo = { id: 0, name: "HEARTBEAT", payloadLength: 9, magic: 50,
    fields: [new MavLinkPacketField("custom_mode", "customMode", 0, false, 4, "uint32_t", ""), …],
    decode: (p) => Heartbeat.decode(p) }

  /// Vehicle or component type. …
  type: MavType = MavType.GENERIC
  …
  customMode: u32 = 0
  mavlinkVersion: u8 = 0

  static decode(p: Uint8Array): Heartbeat { … field by field, little-endian, zero past the end … }
  encode(into: Uint8Array, at: int): void { … }
  info(): MessageInfo { Heartbeat.INFO }
}
```

Each dialect module exports `REGISTRY: Map<int, MessageInfo>` and `MSG_ID_MAGIC_NUMBER`, as in
`mavlink-mappings`.

### 3.4 MAVLink 1 and 2 in one package

The package is universal: it reads and writes both versions, as node-mavlink does.
`MavLinkConnection` takes a `protocol` (`MavLinkProtocolV1` or `MavLinkProtocolV2`, default V2) for
sending, and parses whatever arrives. A v1 frame is limited in what it can carry, so sending one is
checked rather than silently cut:
- message IDs above 255 don't fit v1's one-byte ID: `send` fails with `UNSUPPORTED_BY_V1`;
- v1 has no extension fields: they aren't sent, and the payload is the base length (31 bytes for
  `SYS_STATUS`, not 43). **This departs from node-mavlink 2.3.0.** Its v1 serializer writes
  `PAYLOAD_LENGTH` bytes, and that length includes the extensions. Pico MAVLink follows the
  MAVLink spec here, and the fixture comparison lists it as the one expected difference. Parsing
  accepts both forms.
- v1 has no signing: `sendSigned` is V2 only, as in node-mavlink;
- v1 frames aren't truncated; v2 frames drop trailing zero bytes.

The fixtures (§7) cover both directions for both versions.

## 4. Why generated codecs, not reflection

`protocol.data()` in node-mavlink walks `FIELDS` and sets properties by name. Pico has `std/reflect`,
but it is opt-in metadata for the types that reach `reflect.typeOf`. A generic setter would also lose
the static types that the configurator's typed parameters depend on. So the generator writes
`decode`/`encode` per message: straight-line code, the native integer types (`u8` … `u64`, `i64`
without bigint), and arrays as `Uint8Array`/`T[]`. `FIELDS` stays, as metadata, for UIs and
debugging. Behavior that must match node-mavlink:

- payloads shorter than the message are zero-filled (MAVLink 2 truncation, extensions);
- `char[N]` decodes up to the first NUL, as text;
- `uint8_t_mavlink_version`: `mavlink-mappings` documents it as "added by protocol", but node-mavlink's serializer writes the field's value as given. Pico MAVLink matches node-mavlink's bytes, and `HeartbeatSender` sets 3;
- serialization truncates trailing zero bytes (v2 only), and the CRC covers the truncated packet
  plus CRC-extra.

### 4.1 As built (MV1)

- **Enums are classes of `int` constants** (`MavType.QUADROTOR`), each with `nameOf(value): string?`. Pico enums are sum types without numeric values, and wire data must keep values a dialect doesn't define (newer firmware, bitmasks). So message fields keep their wire types (`type: u8`), and a doc comment names the enum.
- **Names follow `mavlink-mappings` exactly.** Classes, fields (camelCase), enum constants (common prefix cut), and its hand-fixed message names (`StatusText`, `TimeSync`, …). Keywords are valid member names in Pico, so `type` stays `type`; only `operator` would be renamed.
- **Text:** `char[N]` decodes up to the first NUL as UTF-8, and invalid bytes become U+FFFD, as Node's `Buffer.toString` does. Encoding cuts at N bytes and NUL-pads.
- **The generator** (`generator/generate.mjs`) uses `mavlink-mappings-gen@0.0.9`'s `XmlDataSource` for names, field order and CRC-extra, so its output agrees with `mavlink-mappings` by construction. `oracle/check-mappings.mjs` checks all 296 messages of minimal, standard, common and ardupilotmega anyway: ID, name, CRC-extra, lengths, and every field's offset, size, type and units.
- **The XML isn't vendored.** `mavlink/mavlink` is LGPL-3.0, and its generated output is MIT by that project's exception. The generator reads it from a `mavlink-mappings` checkout, pinned by SHA-256.
- **`scripts/check.sh` is the commit gate.** It regenerates and fails on any diff, runs the oracle, runs fmt and lint on the hand-written code, and runs the tests. The generated dialects keep `mavlink-mappings`' names (`GOPRO_RESOLUTION_480p`), which Pico's naming lint flags, so they're linted by the oracle instead.

### 4.2 Interoperability, as built

`oracle/interop.mjs` generates `src/interop.test.pi`. For each of the 296 messages, it sets
seeded random values for every field (64-bit integers, floats, arrays and text included) and
records node-mavlink 2.3.0's frames.
- Pico MAVLink must serialize the message to the same bytes: v2, signed v2 (link 7, a fixed
  timestamp, a passphrase key), and v1 where the ID fits.
- For the 57 messages with extensions, the v1 frame is node-mavlink's without the extensions, with
  that length and its CRC (§3.4).
- Decoding node-mavlink's v2 frame must give back every value.

All 296 pass.

Two messages share a class name in different dialects (`SimState`: common's `SIM_STATE` and
ardupilotmega's `SIMSTATE`), as in `mavlink-mappings`. Code that imports both aliases one of them.

### 4.3 Captures, and a node-mavlink bug Pico doesn't copy

`oracle/counts.mjs` runs node-mavlink's splitter over its own example captures, with the magic
numbers of the four generated dialects so that both sides know the same messages. Pico's
splitter gives the same counts:

| Capture | Frames | valid/invalid/unknown |
|---|---|---|
| `mavlink-v2-3412-packets.bin` | 3398 | 3398/0/14 |
| `GH-5.bin` | 137 | 137/0/1 |
| `vtol.tlog` (tlog splitter) | 23894 | 23894/0/0 |

The tlog count is node-mavlink's when it gets the file in **one** chunk. With 64 KB chunks it
finds 23887, and with 4 KB chunks 23630. When a frame is incomplete at the end of a chunk, its
splitter fast-forwards to the start byte (`buffer.slice(offset)`) and drops the 8-byte
timestamp; the next chunk then needs 8 bytes before that start byte, and the frame is lost. A
first port reproduced that exactly, chunk size by chunk size. Pico keeps the timestamp, and finds
all 23894 frames for chunks of any size, down to 1 byte. Worth fixing in node-mavlink too.

### 4.4 MAVLink 2 payload truncation

The MAVLink spec keeps a payload's first byte even when every byte is zero. node-mavlink 2.3.0
sends an empty payload then. Pico MAVLink follows the spec. Both parsers accept either, and the
seeded values never produce an all-zero payload, so the interop cases don't hit it.

## 5. Operations

PROJECT_DESCRIPTION asks for "classes implementing individual operations". Each is a small class
over a `MavLinkConnection` (a `ByteStream`, a registry, our sysid/compid, a sequence counter, and a
`packets()` loop that hands every packet to the operations listening):

| Class | Does |
|---|---|
| `HeartbeatSender` | sends `HEARTBEAT` every second, with the GCS type |
| `VehicleDiscovery` | watches heartbeats; `vehicles(): Vehicle[]` (sysid, compid, type, autopilot, last seen) |
| `TelemetryStream` | `on(MessageClass, handler)`, filtered by target |
| `ParamList` | `PARAM_REQUEST_LIST`; gathers `PARAM_VALUE` by `param_index`; asks again by index for the missing ones (`PARAM_REQUEST_READ`), with retries and a deadline; returns a partial list explicitly marked as partial |
| `ParamRead` | `PARAM_REQUEST_READ` by name or index, matched on `param_id` and target, with retries |
| `ParamSet` | `PARAM_SET` then waits for the matching `PARAM_VALUE`; compares the read-back with the typed value; a late or unmatched reply is never a success |

Typed parameter values, so nothing is silently coerced to float:

```pico
export enum ParamEncoding { Bytewise, CCast }        // MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_*

export enum ParamValue {
  Int(value: i64, type: MavParamType),               // UINT8 … INT64
  Real(value: f64, type: MavParamType),              // REAL32, REAL64
}

export function decodeParam(wire: f32, type: MavParamType, encoding: ParamEncoding): ParamValue
export function encodeParam(value: ParamValue, encoding: ParamEncoding): f32 throws ParamError
```

- With `Bytewise`, the float's 4 bytes hold the integer (PX4).
- With `CCast`, the float holds the integer's value (ArduPilot).
- The encoding comes from `AUTOPILOT_VERSION.capabilities`. There's an override for an autopilot
  that doesn't report it.
- `PARAM_EXT_*` is deferred (MV3).

### 5.1 As built

- The typed value is `TypedParamValue` (`Int(value, type)` or `Real(value, type)`), not
  `ParamValue`: that name belongs to the generated `PARAM_VALUE` message. For the same reason, the
  write operation is `ParamWrite`, since `ParamSet` is `PARAM_SET`.
- Operations listen through `MavLinkConnection.on`/`waitFor`, and `run()` hands every message
  to them. `waitFor(accept, timeoutMs)` is set up *before* the request goes out, so a fast reply
  isn't missed.
- Only a reply from the target (system, and component unless it's 0) for the same parameter ID
  counts. A late reply after the operation has finished is dropped: its listener is gone.
- 64-bit parameters are refused (`UNSUPPORTED_TYPE`) until `PARAM_EXT_*` (MV3).

## 6. Generator

The generator follows `mavlink-mappings-gen`: it reads the XML, resolves `<include>`s, orders fields
(by size, extensions last), computes CRC-extra, and writes enums, data classes, the registry and
the magic numbers. The output is Pico instead of TypeScript.

- **Language:** TypeScript, run with Node at development time only. Nothing generated needs Node,
  so "no production Node.js dependency" still holds. It is an adaptation of `mavlink-mappings-gen`,
  which keeps the owner's generator behavior (§9, D4).
- **Determinism:** the inputs are the pinned XML files and the generator version. The output is
  checked in under `src/dialects/`. CI regenerates it and fails on any diff, and snapshot tests
  cover `minimal` byte for byte.
- **Oracle:** for every message in `common` and `ardupilotmega`, the generator's CRC-extra must equal
  `mavlink-mappings`' `MSG_ID_MAGIC_NUMBER`, and payload lengths and field offsets must equal its
  `FIELDS`.

## 7. Interoperability fixtures

- **node-mavlink captures:** `examples/mavlink-v2-3412-packets.bin`, `examples/vtol.tlog`,
  `examples/GH-5.bin`. A Node script (dev-time) records what node-mavlink makes of each: the
  valid/invalid/unknown counts, and per packet the header, CRC and decoded fields as JSON. Pico
  MAVLink must produce the same JSON.
- **Encoding direction:** the same script serializes a set of messages (every field type,
  arrays, extensions, trailing zeros, signed v2) with node-mavlink, and Pico MAVLink must produce
  the same bytes. Then the reverse: Pico-encoded bytes parsed by node-mavlink.
- **Malformed input:** truncated packets, a bad CRC, an unknown msgid, an STX inside a payload, a
  signature flag without a signature, junk between packets, 1-byte chunks.
- **Signing:**
  - known-key vectors from node-mavlink's `sendSigned`;
  - a tampered payload, timestamp or link ID must fail `matches`;
  - a replay (timestamp not increasing per link) is rejected under the replay policy;
  - the unsigned-packet policy (`accept`, `accept-listed`, `reject`) is configurable.

## 8. What Pico needs

| Need | Pico today | Plan |
|---|---|---|
| Little-endian integer/float reads and writes at an offset | no `DataView`; typed arrays over a fresh `ArrayBuffer` (as pico-desktop's CBOR codec does) | generated code uses shifts for integers and a 4/8-byte copy into `Float32Array`/`Float64Array` for floats. A `DataView` (or `Uint8Array.getF32LE`…) in Pico would make it faster: propose it to pico-lang once measured |
| SHA-256 | `std/crypto` `digest` | enough |
| UDP and TCP | `std/net` `bind`, `connect` | enough for SITL (MV2) |
| Timers, deadlines | `std/timers` `delay(ms, signal)` | enough for retries |
| Cancellable reads (serial, closing a connection) | missing: pico-lang #100 | needed for a clean disconnect over serial; UDP/TCP have their own close |
| 64-bit integers | native `i64`/`u64` | no bigint needed |

## 9. Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | License of `pico-mavlink` | **Decided (2026-11-07): MIT.** |
| D2 | Names | keep node-mavlink's (`MavLinkPacketSplitter`, `MavLinkPacketParser`, `MavLinkProtocolV2`, `MavLinkData`, `MavLinkPacketSignature`, `REGISTRY`, `MSG_ID_MAGIC_NUMBER`, field names in camelCase as in `mavlink-mappings`). New names: `packets()`, `MavLinkConnection`, `Registry`, `MessageInfo`, `ParamValue`, `ParamEncoding` and the operation classes in §5 |
| D3 | The byte-stream interface | each package declares its own and an application adapts them (no shared dependency); the alternative is a tiny shared `padcom/bytestream` |
| D4 | The generator | TypeScript, adapted from `mavlink-mappings-gen`, emitting Pico, dev-time only; the alternative is a generator in Pico (needs an XML parser in Pico first) |
| D5 | Repository and package name | **Decided (2026-11-07):** repository `padcom/pico-mavlink` (public), package `padcom/pico-mavlink`: the folder's name, with the `scope/` Pico requires |
| D6 | MAVLink 1 | **Decided (2026-11-07):** one universal package that reads and writes both v1 and v2, as node-mavlink does |

## 10. Spike result (2026-11-07)

`spike/` ports node-mavlink's splitter rules to Pico: STX search, v1/v2 lengths, the signature
flag, CRC-16/MCRF4XX with CRC-extra from `mavlink-mappings`' magic-number table, and dropping one
byte on a CRC failure or a whole packet when the message is unknown.
- On `node-mavlink/examples/mavlink-v2-3412-packets.bin` it finds all 3412 frames: 3398 valid, and
  14 whose IDs aren't in the table, skipped as node-mavlink skips them. There are no CRC failures.
- The result is the same for chunks of 1 byte, 7 bytes, or the whole file.
- The CRC matches the CRC-16/MCRF4XX check value (`0x6F91` for `"123456789"`).

So framing needs nothing Pico lacks. The real splitter (MV1) replaces the spike's copy-per-chunk
buffer with a bounded ring buffer.

The oracle agrees. `oracle/counts.mjs` runs the published `node-mavlink@2.3.0` and
`mavlink-mappings@1.0.22-20260311` (dev-time, `npm install` in `oracle/`) over the same capture,
and prints `3398 3398/0/14`, as the Pico spike does.
