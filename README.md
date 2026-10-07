# Galatea, the reference builds

Galatea is an open home brain: a **brain** (a resolver and a language model) asks a **steward**,
which holds the house and decides who may do what; the steward sends actions to exactly one
**applier**, which guards the devices; **bridges** below the applier speak to the devices'
transports, and a **voice front** hears and speaks in the rooms. The standards each part
implements, the conformance harness that grades them, and the architecture are in
[galatea-life-standard](https://github.com/Ludentes/galatea-life-standard).

This repository holds Galatea's own implementations of those standards. Each one is graded by the
published harness, which it takes from npm like any other implementation.

## The builds

| Folder | What it is |
|---|---|
| `reference/steward` | The steward: the house, persons, tiers and the confirmation dialogue, leases, scenarios, rules, schedules, history; an MCP server, Postgres for its state |
| `reference/applier` | The applier: devices, plans, apply and outcomes, liveness, tokens, safety rules, latches, load caps, provisioning and discovery; an MCP server above, MQTT 5 to its bridges below |
| `reference/zigbee-bridge` | A Zigbee bridge on zigbee-herdsman and its device converters, mapping devices onto the standard's vocabulary by meaning |
| `reference/pc-bridge` | A bridge for personal computers (Linux first): the PC as a device, and task plugins hosted as MCP servers |
| `reference/plugins/mpv` | The first task plugin: a media player driven through mpv |
| `reference/wake-relay` | Wakes a sleeping computer for the PC bridge (Wake-on-LAN) |
| `reference/voice-front` | The voice front (Python): listening, the wake word, speech in and out, between the rooms and a brain |
| `reference/owner-tool` | The owner's command-line tool, `galatea`, a direct way in to the steward and the applier |
| `reference/install` | The installation: one Postgres with a role and schema per build, its provisioning, backups and restore, and the Zigbee bridge's image |

The designs behind them are in `docs/specs/`, and step-by-step checks in `docs/guides/`;
`docs/guides/2026-10-05-how-builds-are-checked.md` explains the gates every change passes.
`CONTEXT.md` is the vocabulary.

**Status:** the builds are under active development and not yet released. They pass their
conformance grades against the simulated home, but they are not packaged as container images yet, and
only the Zigbee bridge has run against real devices.

## Working on it

Node 24, pnpm 10, Python 3.11 with `uv` for the voice front, Docker for the tests that need Postgres
or a broker.

```sh
pnpm install
pnpm build
pnpm test:fast                       # every TypeScript package's tests
cd reference/steward && pnpm first-light   # the steward and the applier end to end over a simulated bridge
cd reference/applier && pnpm conformance   # grade the applier against its standard
```

## Licence

Apache-2.0, in `LICENSE`.
