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
- **Next:** `packets(stream)`, the connection, the transports and the operations (MV2).

The framing tests narrow decoded messages with `instanceof`, which needs the fix for
[pico-lang #102](https://github.com/padcom/pico-lang/issues/102) until it's merged.

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
