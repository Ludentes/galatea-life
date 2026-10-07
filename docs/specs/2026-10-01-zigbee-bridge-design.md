---
title: The reference Zigbee bridge — design
status: current
last_verified:
area: architecture
audience: dev
author: Galatea maintainers
related:
  - standard/bridge.md
  - standard/applier.md
  - docs/reviews/2026-10-01-bridge-0.5-applier-0.14.md
  - docs/specs/2026-09-27-pc-reference-build-design.md
  - docs/specs/2026-09-28-storage-design.md
  - docs/plans/roadmap.md
  - conformance/README.md
---

# The reference Zigbee bridge — design

## Changelog

| Date | Change |
|---|---|
| 2026-10-06 | Freshness (plan 5b's spike, for the maintainer to approve; *Freshness*): a device in reach (5 s) polled every 5 minutes with one read of genBasic, `basis: poll`, its bound three times that; an hourly battery report configured on the vibration sensor and the radar, its bound twice that once accepted; `reports`, `reportsIgnored`, `rhythm` and `poll` in the override table; the configure's kept version carrying the table's reports; hardware admitted anew configured again; the bench's checks written, not run (a configuration is a write to a device) |
| 2026-10-06 | What the bench taught, for bridge 0.6 (plan 5, for the maintainer to approve): the mapping layer, by meaning (GA-BRIDGE-78); keys held back until first reported (GA-BRIDGE-80); undescribed data an event and a kept list, duplicates check-ins (GA-BRIDGE-76); every confirmed setting kept and published after a restart (GA-BRIDGE-79); plan 5 split into 5a (these, over both doers, with the harness) and 5b (freshness: polling and configured reports, on the bench) |
| 2026-10-06 | The bridge installed (plan 4a, for the maintainer to approve): the bridge's image; a Galatea broker in the install's compose, with a password and an access rule for each build in `instances`; the bridge's service, its data directory and its stop grace; the owner's `form` and `backup` run in a one-off container of the bridge's image while its service is stopped, not through `docker exec`; the broker's and the store's passwords read from files. Plan 4 split: 4a the bridge installed, 4b first light. Where the stack runs is not chosen here (the maintainer, 2026-10-06). |
| 2026-10-05 | Plan 3b's review (the controller's rulings, for the maintainer's plan review): the close the doer owes the coordinator (a window closed while no controller is up, or whose close failed; any permit a crashed bridge left, closed by the first controller after a start; a permit that lands after its window closed); a removal still waiting ends when its hardware is admitted anew; a forced removal with no controller up waits for the next; a secured rejoin reported for all hardware herdsman has, the core keeping the device the store kept; a force-removed device comes back as new hardware in a window or not; Green Power commissioning named; the converters' hooks' reason corrected. |
| 2026-10-05 | The herdsman doer's provisioning made buildable (plan 3b, for the maintainer to approve): spike S7's answers (a refused join is one Leave Request and changes nothing; `removeFromNetwork` rejects when the device does not answer, its record kept; known hardware let in raises no event); the guard's removal opening; how a removal waits, rejects and is forced; the window's seconds, its close at `join_close` and at a stop; the join handler's share of the window rule, with the admissions it reports itself; the converters' `deviceJoined` and `deviceInterview`; `router` from herdsman's device type; `GALATEA_ZIGBEE_NO_ACTIONS` refusing provisioning. |
| 2026-10-05 | Plan 3a's review and the maintainer's window rule: an indication for hardware herdsman has is a new admission while the doer's window is open, a rejoin outside it; `mayAdmit` asked before every arrival reported as new, known hardware included, and the core's own guard against blocked hardware; a `join` while a window is open is `failed(busy)`; the doer's window calls in order; Provision claimed only over a doer that provisions (`provisions`), and a removal the doer rejects kept pending under a `remove_refused` fault; a `remove` with `blockRejoin` naming an earlier id removes the hardware's device now too; blocked hardware still had at a start removed again. The departure from the standard's "a secured rejoin sends no `joined`, even while a window is open" named. |
| 2026-10-05 | Provision made buildable (plan 3's spike, for the maintainer to approve): `near` offered, a window without it house-wide; the blocklist the core's, answered through `mayAdmit`, and the port's `block` and `unblock` dropped; `remove`'s and the window's rules; a device's `stableIdentifier` is its hardware id; spike S6 answered; plan 3 split into 3a and 3b. |

**Classification: architectural.** `reference/zigbee-bridge` does not exist. This is a new build
with a new seam to a Zigbee stack, new harness seams and tests, and a device model derived from a
third-party library.

## What it is

The roadmap's core names "a Zigbee bridge" (*The core: steward, applier, Zigbee bridge*), and its
first light is "one real Zigbee lamp switched by a model through the whole chain". This is that
bridge.
- It conforms to [`standard/bridge.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/standard/bridge.md) 0.5 at levels **Serve** and **Provision**.
- It runs on the home box beside the broker.
- It reaches a Zigbee coordinator over TCP: the first install's is an SLZB-06P7U (CC2652P7,
  Z-Stack) on the LAN.

## Decisions already made

- **The route** (the maintainer, 2026-10-01): our own bridge on **zigbee-herdsman** and
  **zigbee-herdsman-converters** (both MIT), not a shim over zigbee2mqtt. zigbee2mqtt never
  confirms a `set` over MQTT, so a shim could only ever ack `sent`. Galatea's standard also puts
  provisioning in the bridge, which is where owning the stack pays.
- **Levels** (the maintainer, 2026-10-01): Serve and Provision. Box and Find come later.
- **Coverage** (the maintainer, 2026-10-01): **generic plus overrides**.
  - Every device is described from its converter definition's `exposes`.
  - Exact matches map to the applier's closed vocabulary; everything else becomes extensions.
  - A small per-model override table, written from the device passports, says what `exposes`
    can't.
- **The standard it builds against:** bridge 0.5, applier 0.14 (PASS 2026-10-01). That revision
  exists because of this bridge's bench spikes: extensions on any device, `state`/`event` keys,
  occurrences, re-description when a setting changes a declaration, and undescribed keys as an
  owner fault.
- **Storage** (the maintainer, 2026-09-28): one Postgres for every reference build, a schema and a
  role per build. This bridge's schema is `bridge_zigbee`.
- **Shape** (ruled for the PC build): no shared bridge library. Each bridge transcribes the
  Serve-generic binding from the PC bridge.

## Evidence this design rests on

All of it is private working material, summarised here so that a stranger can follow:
- **Source reading** of herdsman v10.10.0, the converters v26.114.0 and zigbee2mqtt 2.14.1 (read
  only; GPL, nothing copied).
- **Two bench spikes** on the real coordinator: the TS0210 vibration sensor and the Fingerbot Plus.
  The passports are in the home install's own records.

The facts that shape the design:

| Fact | Where it bites |
|---|---|
| herdsman can silently form a **new** network when its config and the coordinator disagree (`ZnpAdapterManager`'s start strategy logs it at debug level) | *The network guard* |
| Leaving out `networkKey` or `extendedPanID` gives well-known values; a mismatch error logs the key in hex | GA-BRIDGE-24; the logger redacts |
| herdsman never reconnects, and a half-open TCP link goes unnoticed for 11+ minutes | *Coordinator link* |
| `Endpoint.command()` resolves `{cmdId, statusCode}` and never throws on a ZCL failure status; `write`/`read` throw `StatusError` | *Command results* |
| A device answers "SUCCESS" even to a command it ignores (Fingerbot `offWithEffect`) | Confirmation comes from the report (GA-EVT-3); the ack is only the protocol's word |
| Default recovery can send a command up to 5 times, plus once more on timeout | `disableRecovery` for non-idempotent actions |
| Tuya datapoint sends have no protocol answer, but the device echoes the value it holds, including a refused one | Tuya settings ack `sent`, with `confirmedBy` |
| A Tuya setting can actuate (Fingerbot `mode` pressed the arm) and change other settings | Extension tier; re-publish every key from a dump |
| `mode` changes what `onoff.turn_on` is (click = a press every time) | Re-description, GA-BRIDGE-74 |
| The TS0210 alarms on every movement and never clears | An `event` key |
| Converters have side effects (Tuya time sync, IAS enrolment answers) and must see every inbound message | *The converter pipeline* |
| Converters return optimistic state from `convertSet`, and some derive values from their cache (TS011F `power = 0` when off) | Discard both; publish only what a device message carried |
| `lastSeenChanged` fires for every ZCL frame, Default Responses included | Check-ins come from device-originated application messages |
| A leave makes herdsman delete the device before it emits `deviceLeave`; a rejoin after removal returns the same `Device` object | *Admission and ids* |
| `permitJoin` is capped at 254 s; coordinator-only join was fixed only in 10.9.6 | Pin herdsman ≥ 10.9.6; the window rules |

## Approaches considered

**A. One core over a doer port (chosen).** A `ZigbeeBridge` core holds every rule of the standard:
- the wire, status loop, roster, acks, de-duplication, occurrences, re-description, provisioning
  state and the leave order.

It talks to a **doer port** that speaks the Galatea device model:
- the port sends descriptions, observations, occurrences, check-ins and protocol results;
- the core sends execute, read, join, close and remove.

Two doers implement the port:
- the **herdsman doer**, where herdsman, the converters, the mapping and the overrides live;
- the **scripted doer**, which the harness drives on the test-control topic.

This is the PC bridge's shape (core, port, scripted backend). It lets the harness grade every
standard rule without a radio, and keeps herdsman's quirks out of the core.

**B. A thin core with the herdsman layer producing wire messages.** Fewer layers, but every
standard rule would sit next to herdsman calls, and only a real coordinator could test it. The
harness could grade nothing but the scripted path, which would then be a second implementation.
Rejected.

**C. A shared bridge library extracted from the PC bridge.** Already ruled out ("no shared
library"). The binding is transcribed instead.

## Architecture

```
reference/zigbee-bridge/
  src/
    main.ts             entry: config, store, lock, wire, doer, core; signals
    bridge.ts           ZigbeeBridge: the standard's rules (Serve + Provision)
    wire.ts             MQTT 5 binding, transcribed from the PC bridge
    port.ts             the doer port: types only
    store.ts            Postgres schema bridge_zigbee
    instance-lock.ts    transcribed
    scripted-doer.ts    the test transport's doer (GALATEA_TEST_TRANSPORT only)
    herdsman/
      doer.ts           HerdsmanDoer: controller lifecycle, link health, rebuild
      network-guard.ts  form / resume / refuse; key and backup handling
      pipeline.ts       converter pipeline: fromZigbee, onEvent, dedup, time sync
      describe.ts       exposes → core capabilities and extensions; confirms; bounds
      overrides.ts      per-model table, from the passports
      execute.ts        convertSet through a recording endpoint → ProtocolResult
      provision.ts      permitJoin, join classification, blocklist, remove
      cli.ts            `zigbee-bridge form` and `zigbee-bridge backup`
  test/                 vitest: core over a fake port; herdsman parts over fake devices
  subject.json          for the harness, test transport only
```

The core and the scripted doer import only `@ludentes/galatea-life-schemas`, `@ludentes/galatea-life-test-clock`, `mqtt` and
`pg`. Only `herdsman/` imports zigbee-herdsman and its converters, so the core builds and tests
without them.

### The doer port

The port is the boundary.

**From the doer:**
- **`described(device)`:** a device entry as *Devices* gives it, with every declaration, keyed by
  the doer's `hardwareId` (the IEEE address). It is sent on interview, on a definition change, and
  on any re-description.
- **`observed(hardwareId, readings, time, checkIn)`:** readings keyed by the applier's key or an
  extension key, stamped with the device message's time. `checkIn` is true for a device-originated
  application message.
- **`occurred(hardwareId, key, value, time, frameId)`:** `frameId` lets the core drop a repeat
  (GA-BRIDGE-75).
- **`undescribed(hardwareId, names)`.**
- **`admitted(hardwareId, how)`**, where `how` is `association`, `tcRejoinWellKnown`,
  `securedRejoin` or `tcRejoinUniqueKey`; **`interviewed(hardwareId)`**, published as `interviewed`
  naming the device where the hardware has an id; **`left(hardwareId)`**.
- **`mayAdmit(hardwareId)`**, asked before every arrival the doer will report as new: hardware it
  does not have, and, by the window rule (*Rulings*), hardware it has that comes in while the doer's
  window is open. It is answered at once from memory. False for blocked hardware: the core publishes
  `blocked_rejoin` naming its identifier, and the doer turns the hardware away (herdsman removes it
  at once, which is GA-BRIDGE-27's "removed again"). False too, while the store is away, for
  hardware the bridge has a device for (the maintainer's ruling, 2026-10-04). The core does not
  rely on being asked: a new admission of blocked hardware a doer reports without asking gets a
  `blocked_rejoin`, the doer is asked to remove it, and it is never admitted.
  A `left` always takes the device out of `devices` and the roster, and clears its retained status
  (GA-BRIDGE-21). The core writes the removal to the store before publishing it. A leave while the
  store is down is replayed at start: the doer reports every hardware id the store holds that
  herdsman no longer has as `left`, so an entry never outlives its device.
- **`transport(state, since, retryIntervalMs?)`**, and **`fault(code, detail)`** (`detail` null
  clears it). The doer owns GA-BRIDGE-23's 30 s window and GA-BRIDGE-11's backoff, and the core
  publishes what it is told.

**From the core:**
- **`execute(hardwareId, action, args, deadline)`**, `args` named and already checked by the core, returning a `ProtocolResult`:
  - `confirmed`;
  - `transmitted`, for a path with no answer;
  - `refused(reason)`;
  - `lost`, when delivery failed after transmission;
  - `notSent(reason)`.
- **`read(hardwareId, keys, deadline)`**, for GA-BRIDGE-34's read-back.
- **`join(windowMs, near?)`**: opens a window for `windowMs`, already the lesser of the request's and
  the cap, house-wide, or at the router `near` names. **`joinClose()`**. The core keeps the window's
  time on its own clock and closes it itself. The doer's window is open from its `join` call to its
  `joinClose` call, not by the stack's own permit-join timer (whole seconds); the core makes these
  calls one at a time, each once the one before it settled, so a `join_close` followed at once by a
  `join` reaches the stack in that order.
- **`remove(hardwareId, force)`**: resolves once the hardware is out of the network, the doer having
  reported it `left`. Without `force` it waits for a device that does not answer (a sleepy one) to
  answer; with `force` the device is dropped at once. It rejects when the doer could not remove the
  hardware.
- **`provisions`**: whether the doer opens windows and removes devices. The bridge claims Provision
  in `levels` only when it does; otherwise `levels` is `["Serve"]` and `join`, `join_close`,
  `remove` and `unblock` are `invalid_request`, as an op outside `levels` is. The herdsman doer says
  false until plan 3b.
- **`start()`**, **`stop()`**.

The blocklist is the core's, kept in the store and answered through `mayAdmit`; the doer holds none,
so the port has no `block` or `unblock`. A device's `stableIdentifier` is its hardware id (the IEEE
address), and the port refuses a description where they differ, so `remove { identifier }`,
`unblock { identifier }` and `status.blocked` name hardware by the id the doer uses. A description
says `router: true` for a device a window can open at; it is the port's, never published.

The core maps a `ProtocolResult` to an ack:

| `ProtocolResult` | Ack |
|---|---|
| `confirmed` | `applied` |
| `transmitted` | `sent`, only where the action is `confirms: false` (GA-BRIDGE-8) |
| `refused(r, detail)` | `failed(r)`: `refused` ("another reason") with the protocol's status as `detail` |
| `lost` | `failed(no_confirmation)` |
| `notSent` | `failed(unreachable)` or `expired` |

Device ids are the core's. The core maps `hardwareId` to a device id, the admission rule being
GA-BRIDGE-35, and keeps that map in the store.

### The core (`bridge.ts`)

The Serve-generic parts are transcribed from `reference/pc-bridge/src/bridge.ts`:
- the start order, the status loop, roster entries, commands with de-duplication and deadlines,
  requests with de-duplication, retained deliveries ignored, events with `seq`, the leave order,
  reconnects and the stall op.

The PC-specific parts are dropped. Added for this bridge:
- **Extensions, kinds and the status filter.** A device's status carries only the keys its entry
  declares as `state` (GA-BRIDGE-1). An `event` key becomes an `occurrence` event and never enters
  the status (GA-BRIDGE-75). Undescribed names become an `undescribed_keys` fault (GA-BRIDGE-76).
- **Re-description.** On a `described` that changes a known device's declarations, the core
  publishes `devices` before the observation that carried the setting (GA-BRIDGE-74). The doer
  sends `described` before the `observed` that triggered it, and the core preserves that order on
  the wire.
- **Read-back** after `applied`, `sent` or `no_confirmation` for a stateful action on a closed
  device (GA-BRIDGE-34), timed as *Commands* gives it.
- **Provision:**
  - `join`, `join_close`, `remove` and `unblock` requests;
  - `joined`, `interviewed`, `left`, `window_closed` and `blocked_rejoin` events;
  - the blocklist in `status.blocked`, and `levels` `["Serve", "Provision"]` over a doer that
    provisions;
  - GA-BRIDGE-25 to 28 and 35;
  - `commission` and `connect` refused, as Zigbee has neither (GA-BRIDGE-28, and GA-BRIDGE-40's
    `invalid_request` for a bridge with no manifest).
- **The window** (GA-BRIDGE-25, 26):
  - `join { transport, windowMs, near? }` names the coordinator's transport and a whole number of
    milliseconds above 0, else `invalid_request`; a `near` the bridge has no device for is
    `failed(unknown_device)`, and one that is no router `invalid_request`.
  - It is answered `accepted`, then opened for the lesser of `windowMs` and 254 000 ms, on the
    core's clock. `window_closed { transport, devices, windowMs }` ends it, with every device a
    `joined` named while it was open and that effective `windowMs`: at its time, on `join_close`, at
    a leave (GA-BRIDGE-22), when the store fails, or at once when the doer could not open it.
  - A `join` while a window is open is `failed(busy)` (*Commands*, GA-BRIDGE-4), checked with
    nothing awaited between the check and the opening, so of two `join`s delivered together one
    opens the window and the other is `busy`. `join_close` with none open is `ok` and sends nothing.
- **Removal and the blocklist** (GA-BRIDGE-21, 27):
  - `remove { device | identifier, blockRejoin, force? }`: `device` is a device id, `identifier`
    a hardware id. One the bridge never gave or never had is `failed(unknown_device)`.
  - With `blockRejoin`, the hardware is written to the blocklist before the reply. It is answered
    `accepted`; the doer removes the hardware, and `left` names its device. An id the hardware no
    longer has (it left, or was admitted anew since) is "already gone": `left` names that id at once,
    and the hardware's current device, if any, is untouched, unless the `remove` has `blockRejoin`:
    blocked hardware is kept out of the network (GA-BRIDGE-27), so its current device is removed
    too, and `left` names each id removed.
  - A second `remove` of hardware being removed waits for the first; one `left` ends both.
  - A removal the doer rejects stays pending, as one waiting for a silent device does: a
    `remove_refused` fault on the device names the doer's reason, a second `remove` waits, and a
    `remove` with `force` ends it, on the bridge's own word if the doer rejects that too.
  - At a start, once the first `devices` is out, a removal (without `force`) starts for every
    blocked hardware the bridge still has, so a removal a restart cut off still ends in its `left`.
  - `unblock { identifier }` takes the hardware off the blocklist, `ok`, whether it was on it or not.
  - Blocked hardware the doer asks about (`mayAdmit`) is refused, in a window or not, with a
    `blocked_rejoin { identifier }`, and never admitted; one the doer brings in without asking is
    turned away by the core the same way, and the doer asked to remove it.
- **While provisioning cannot be done safely:** with `state_mismatch`, `join`, `join_close`,
  `remove` and `unblock` are `failed(state_mismatch)` (GA-BRIDGE-12); while the store is away,
  `join`, `remove` and `unblock` are `failed(store_fault)`; while the coordinator is down, `join` is
  `failed(unreachable)`.
- **Faults:** `state_mismatch` (GA-BRIDGE-12, and everything is served `down`), `undescribed_keys`,
  `no_network`, `remove_refused` (the bridge's own), and `publish_refused`/`subscribe_refused` as
  the PC bridge has them.

### The herdsman doer

**Controller lifecycle and the coordinator link.** One `Controller` per process, since herdsman
keeps static state.
- The core's transport is `up` only on a successful exchange within 30 s (GA-BRIDGE-23).
- **The health exchange** runs every 10 s and never overlaps the previous one. It is a ZDO Node
  Descriptor request to network address 0 through `sendRaw`, under the doer's own 8 s deadline;
  bench spike 1 (2026-10-01, the probe's `probeZdo`) measured about 10 ms. A real device message
  also counts as an exchange.
- **On a failed exchange or `adapterDisconnected`**, the doer stops the controller and builds a
  new one. Retries back off 10, 20, 40, then 60 s (GA-BRIDGE-11), resetting only on a successful
  exchange. The process never exits on a coordinator loss (GA-BRIDGE-10); a deployed bridge that
  exited on one did so 916 times.
- `tcp_retries2` is left alone; the probe is the detector.
- **A rebuild** gets new `Device` objects, since `Controller.stop()` resets herdsman's cache. The
  pipeline re-resolves every definition and sends `onEvent` `start` again.
- *Spike S3* (the cable pull) measures whether `adapterDisconnected` ever comes before the probe
  does.

**The network guard (`network-guard.ts`).** The bridge never forms a network on its own:
- **Forming is an owner act:** `zigbee-bridge form --channel N`.
  - It refuses if a network config or a coordinator backup exists.
  - It generates a fresh 16-byte network key, a PAN id and an extended PAN id (GA-BRIDGE-24).
  - It writes them to `network.json` (mode 0600, in the bridge's private data directory).
  - It starts herdsman, which must return `reset` (formed), and records the coordinator's IEEE
    address and the backup.
- **On every later start**, the doer passes herdsman the config from `network.json`, channel
  included, and expects `resumed`. herdsman moves the coordinator to a configured channel that
  differs; since the config is the one formed, a difference means someone changed the coordinator,
  which S4 checks for, and it is `state_mismatch`.
  - If `start()` returns anything else, or the coordinator's IEEE address differs from the
    recorded one, the doer reports `state_mismatch` (GA-BRIDGE-12) and serves nothing.
- **A missing `network.json`** is the fault `no_network`, never a form.
- **Whether `resumed` can be guaranteed** before herdsman acts is *spike S4*. The silent reset
  happens inside `start()`, so the guard must prevent it, not detect it afterwards.
  - The candidate prevention: run with herdsman's `backupPath` present, and compare the
    coordinator's NV (read through the adapter before `start`, or herdsman's own
    `checkConfiguration`) with `network.json`.
  - Its answers decide the guard's code.
- **Secrets.** The network key is redacted from herdsman's log, which goes through `setLogger`. The
  backup holds the key in clear, so it stays in the private data directory. `zigbee-bridge backup`
  copies `network.json` and the coordinator backup into one owner-only file for the owner to keep.

**The converter pipeline (`pipeline.ts`).** It does what zigbee2mqtt's receive and `onEvent`
extensions do, written from the converters' public API:
- **Resolving the definition:** `findByDevice(device, true)` after a successful interview and on
  start. A generated definition gives `classEvidence: protocol`; a database match gives
  `model_db`.
- **Every inbound message** goes through every `fromZigbee` converter whose cluster and type match.
  The side effects need it.
- **De-duplication** is by the device, endpoint and ZCL transaction number within 10 s, which is
  the converters' own window. The spike saw the TS0210 repeat a report with the same TSN.
- **A converter's output is an observation** only when it comes from the message itself.
  - Values a converter derives from its cache are dropped by a per-key rule in the override table
    (TS011F `power`).
  - A late `publish()` is stamped with the time of the message it rests on.
- **`onEvent`:** `start`, `stop`, `deviceAnnounce`, `deviceJoined` and `deviceInterview` are
  delivered as zigbee2mqtt delivers them, and `stop` clears a device's timers on leave and removal.
- **Check-ins** are application messages from the device: ZCL frames it originated, not Default
  Responses and not address replies (GA-BRIDGE-37).

**Describing a device (`describe.ts`).** From the definition's `exposes`:

| Expose | Becomes |
|---|---|
| `switch` (`state`), a light's `state` | `onoff` |
| a light's `brightness` | `level` (0–254 → 0–100) |
| a light's `color_xy` / `color_hs` | `color` (`#rrggbb`) |
| `cover` `position` | `cover` |
| `lock` `state` | `lock` |
| `climate` `occupied_heating_setpoint`, `system_mode`, `local_temperature` | `climate` |
| numeric `temperature`, `humidity`; binary `contact`, `water_leak`, `occupancy`; numeric `battery` | `sensor` keys `temperature`, `humidity`, `contact`, `leak`, `occupancy`, `battery` |
| an `action` enum | an extension `event` key |
| anything else | an extension: the capability `org.galatea.zigbee.<definition slug>`; each property a key (`state`, or `event` where the override says so); each writable property an action `set_<property>` with `confirmedBy { key, value: { arg: value } }` and `args` from the expose's range or enum |

- **The definition slug** is the converters' `model`, lower-cased, with every other character
  `_`. `TS0001_fingerbot` becomes `org.galatea.zigbee.ts0001_fingerbot`.
- **Polarity.** The converters' `contact: true` means the contact is made, so the door is
  closed. The applier standard lists `contact` without saying which way it reads, which is a gap
  in the standard. The bridge follows the converters (*Rulings*), and the gap goes to the applier's
  next revision.
- **`confirms`** per action comes from a **dry run**: the converter's `convertSet` is called
  against a recording endpoint that sends nothing, and the shape of the call decides.
  - A ZCL `command` that expects a Default Response, or a `write` that waits for its Write
    Response, is `confirms: true`.
  - A call with `disableDefaultResponse`, or a Tuya `dataRequest`/`sendData`, is
    `confirms: false`.
  - A converter that throws on a recording endpoint offers no action.
  - *Spike S5* checks the dry run across the definitions of the devices in the flat.
- **`idempotent`:** a set is idempotent unless the override table or the action's kind says
  otherwise. `toggle` is never offered; the core only sets.
- **The freshness bound** (*Freshness*): for a device the doer polls, three times the poll's cadence;
  otherwise twice the longest configured reporting maximum the definition's `configure` or the
  override's `reports` set up, once accepted; otherwise twice the interval the bench measured the
  model reporting at (`rhythm`). Otherwise null (GA-BRIDGE-13), and the owner sets a bound at the
  applier. The bridge never guesses one.
- **`reachMs`** is the device's poll interval, as *Devices* defines it: 0 for a device with
  `rxOnWhenIdle`.
  - For a sleepy end device, it comes from its Poll Control long-poll interval where the device
    has genPollCtrl, or from the override table where the bench measured it.
  - An action on a device whose `reachMs` is unknown or over 145 s is **not offered**
    (GA-BRIDGE-7's "a device it cannot reach within 145 s … is offered no action"). So the
    TS0210's `sensitivity` is not offered: it has no Poll Control, and it listens only for a
    second or two after an event.
  - No action goes through herdsman's own queue (`sendPolicy: immediate`), so a command whose time
    runs out is never delivered later (GA-BRIDGE-7).

**The override table (`overrides.ts`).** Keyed by the converters' `model`, it is data, not code
branches. Each entry may:
- mark keys as `event`, `personal` or `selfChanging`;
- drop keys, either derived ones or the converter's own timers' outputs (the TS0210's
  `vibration: false`);
- name a setting that drives re-description, with a function from its value to declaration
  changes.

The first entries come from the passports:
- **`TS0210`:** `vibration` is an `event` key, and the converter's timeout-made `false` is
  dropped. `sensitivity` is declared with `args` 0–50, enforced by the bridge since the device
  accepts 200, but **offered only once a `reachMs` of 145 s or less is known** for the device;
  today none is, so it is not offered.
- **`TS0001_fingerbot`:**
  - `mode` and `reverse` are declared `state` keys.
  - In `click` mode `onoff.turn_on` and `turn_off` are `idempotent: false`; in `switch` mode they
    are idempotent.
  - Until `mode` has been observed, `onoff` is not offered (GA-BRIDGE-74).
  - `set_mode`'s `args` are `click` and `switch` only, and `program` is not offered (its format
    is unknown).
  - `reachMs` is the bench's measured answer time, 2500 ms ⚠️, until a poll interval is measured.
    Plan 2's bench guide measures it: Poll Control attributes where the device has the cluster,
    otherwise the answer time of commands sent at random moments while it is idle (the MAC data
    requests stay inside the coordinator's firmware, so herdsman never logs them).

An extension `state` key that no `confirmedBy` names is `selfChanging` (bridge 0.5).

**Command results (`execute.ts`).** `convertSet` runs against a **recording endpoint**, a proxy
that records each `command`, `write` and `read` with its result:
- **Its optimistic return is discarded.** The `ProtocolResult` is computed from the record:
  - a `command` with `statusCode` 0 is `confirmed`, and a non-zero one is `refused`;
  - a `write` that resolved is `confirmed`, and a `StatusError` is `refused`. That includes one
    herdsman raises locally before sending (the bench's 0 ms `NOT_AUTHORIZED` for a read-only
    attribute), since the call reached the stack;
  - a Tuya send is `transmitted`;
  - a data-confirm failure, a MAC or route error, a timeout, or any throw after a call reached
    herdsman is `lost`.
- **`notSent` means no call reached herdsman at all.** Handing a frame to the stack counts as
  transmitting it (*Commands*). So `notSent` covers only the cases where the core never called
  `execute`, or the converter threw before its first `command`, `write` or `read`; it alone maps
  to `unreachable` or `expired`.
- **`refused` is acked `failed(refused)`,** with the ZCL status name (`UNSUP_COMMAND`) as `detail`.
- **Options:** `disableRecovery: true` for every action declared non-idempotent, and the command's
  remaining time as herdsman's `timeout`.
- **The read-back** uses `convertGet` where the definition has one. A Tuya device has no read on
  demand (the Fingerbot ignores `dataQuery`), so its echo is its observation.

**Running `configure`.** A definition's `configure` (binds, reporting) runs after a successful
interview, again when the definition's `version` changes, and again on a `deviceAnnounce` where the
definition asks for it.
- Whether it has run, and at which version, is kept in herdsman's device `meta`, as zigbee2mqtt
  keeps `configured`. That persists in herdsman's own database.
- A failure (a sleepy device asleep) is retried at the device's next message, at most once per
  10 minutes.
- The override's `reports` run in the same run, after the definition's `configure` (or alone, for a
  definition with none), each a reporting set-up on the first endpoint that serves its cluster. The
  version kept is the definition's with a hash of the table's reports, so a changed table configures
  the device again (*Freshness*).
- Until `configure` succeeds, the device's bound from configured reporting is null.
- Hardware admitted anew (herdsman's `deviceJoined`, or the window rule's re-admission) has herdsman's
  `meta.configured` forgotten, as zigbee2mqtt's `onDeviceJoined` does: herdsman's record outlives a
  leave, and the device may have been reset. It is configured again, its bound null until then.
- `configure` and every other converter `onEvent` exchange (time sync, IAS enrolment answers)
  changes no device state the applier holds. `permitJoin` opens only on a `join` request. So the
  bridge itself acts outside the applier only in ways the standard allows, and `ungoverned` stays
  empty (GA-BRIDGE-32).

**Seeing undescribed data.** The doer compares each Tuya message's datapoint numbers with the
definition's `meta.tuyaDatapoints`, and reports the others as `dp<N>` (the Fingerbot's 108, 111,
112–117, 119, 121, 122). A ZCL attribute report on a cluster no `fromZigbee` converter takes is
reported as `<cluster>.<attribute>`. These go to `undescribed` (GA-BRIDGE-76).

**Provisioning (`provision.ts`).**
- **The window:** `controller.permitJoin(seconds)`, herdsman's broadcast, so the window is
  house-wide; with `near`, `controller.permitJoin(seconds, router)`, at that router alone
  (GA-BRIDGE-26). `seconds` is the effective `windowMs` in whole seconds, rounded up, at least 1, and
  the core closes the window at its own time whatever the coordinator counts. `join_close` is
  `permitJoin(0)`, sent only while the doer's window is open (with none open it changes nothing),
  and also sent before the doer stops when its window is open, since the doer's close sends no
  frame. A `near` herdsman does not have, or that is no router in herdsman's model, makes `join`
  reject (the core ends the window at once). `join` rejects while no controller is up; a `remove`,
  with `force` or without, waits for the next controller (*`remove`*).
  The window stays the doer's across a controller rebuilt within it; the new controller sends no
  permit of its own, and the coordinator's ends at its own time.
- **The close the doer owes** (plan 3b review I2, M1). The doer keeps when the coordinator's last
  permit ends. Two other cases leave the coordinator permitting joins with no window of the doer's
  open, and in each the doer owes it a close, sent as one `permitJoin(0)`, bounded by `PERMIT_MS`:
  - **a window closed while the coordinator cannot be reached**: a `join_close`, or the window's
    end, while no controller is up (the link down), or whose close herdsman did not answer. The
    window ends all the same; the close is sent once the next controller is up, unless the permit
    has run out by then.
  - **a crash in a window**: herdsman's Z-Stack resume does not reset the coordinator, and a permit
    of up to 254 s outlives the bridge. The first controller after the process starts sends one
    close once it has resumed, whatever the bridge's last run did.
  A permit herdsman settles after the doer gave up on it at `PERMIT_MS` and its window closed is
  closed again the same way. An owed close is not sent while a window is open (that window's close
  follows), and a join's permit is sent only after an owed close under way. Under the owner's switch
  nothing is owed and nothing sent. The close goes through the controller's `permitJoin` alone, as
  every permit does; no guard is opened for it.
- **The guard's openings for provisioning.** `permitJoin` is herdsman's controller's, which no
  converter reaches (the guard hands converters models only, their `constructor` a stand-in): the
  doer calls it from `join`, `joinClose`, its stop and the close it owes, nowhere else. A removal calls herdsman's
  `Device` through the guard, opened for that removal alone (`removing`): `removeFromNetwork` for a
  removal without `force`, `removeFromDatabase` alone for one with it, through a gate closed when the
  call ends; every other method stays refused, as for a converter.
- **Spike S7's answers** (plan 3b, herdsman 10.10.0 over a stubbed adapter, controls passed): a join
  the handler refuses is one Leave Request without rejoin, and changes nothing in herdsman (no
  record made, a known one kept, no event); `removeFromNetwork` rejects when the device does not
  answer (on Z-Stack after its 10 s wait for the response), with herdsman's `Zdo.StatusError` when
  the device answers with a failure, the record kept either way, and resolves with the record
  deleted and no `deviceLeave` when it answers SUCCESS; hardware herdsman has, let in, raises no
  `deviceJoined` and no interview.
- **Classifying an arrival: spike S6's answer.** No frame tells the four kinds apart. herdsman
  10.10.0 parses Z-Stack's trust-centre device indication as `{nwkaddr, extaddr, parentaddr}`,
  turns it into a bare `deviceJoined { networkAddress, ieeeAddr }`, and calls
  `acceptJoiningDeviceHandler` on every indication, known devices included; its Ember adapter drops
  the stack's status the same way; a known device is never interviewed again. The only signals are
  herdsman's own deletion (hardware herdsman deleted on a leave, or never had, is new) and the
  doer's window (an association needs a parent permitting joins, so an indication for hardware
  herdsman has, outside every window, is a rejoin, though not which kind). The bench record: the
  TS0210 rejoined on its own outside any window and raised the indication.
  - Reading every indication as an association would give a router a new id after every power
    cut, evicting the adopted device, which the standard calls "not new".
  - The rule is the window rule, the maintainer's (*Rulings*), and it is the herdsman doer's
    classification; `admitted(hardwareId, how)` is unchanged. The doer keeps its window's state from
    its `join` call to its `joinClose` call. An indication for hardware herdsman has is reported as
    an `association` while that window is open, and as a `securedRejoin` outside it; hardware
    herdsman deleted on a leave, or never had, is a new admission, in a window or out.
  - The join handler asks `mayAdmit` for unknown hardware, and for known hardware inside the
    window; a refusal is herdsman's Leave Request. herdsman never interviews known hardware again,
    so the doer re-describes a device admitted anew this way under its new id itself.
  - Since herdsman raises nothing for known hardware it lets in (S7), the join handler reports it
    itself, once the core lets it in: `admitted(hw, "association")` inside the window, its
    description sent again (unchanged, so sent though nothing in it changed), and no `interviewed`
    (no interview happened); `admitted(hw, "securedRejoin")` outside, which keeps its id, for all
    hardware herdsman has, described or not: the core counts a device the store kept, not yet
    described, as still in `devices` (GA-BRIDGE-35), so a rejoin during a start keeps it (plan 3b
    review, gap b). A removal still waiting for the hardware's earlier device ends when the window
    admits it anew (plan 3b review I1): no frame and no `left` from the doer, so no Leave Request
    reaches the device just paired; the core names the earlier device `left` and drops its removal,
    and a later `remove` of the new device runs. Unknown hardware is reported by herdsman's own
    `deviceJoined` (an `association`) and its interview.
  - The handler answers at once from the doer's memory and the core's: it awaits nothing.
  - Under the owner's switch (`GALATEA_ZIGBEE_NO_ACTIONS=1`) the handler refuses nothing, since a
    refusal is a Leave Request, a frame, and asks no `mayAdmit`; the core's own guard still keeps
    blocked hardware out of `devices`. The switch makes `provisions` false too: no window opens and
    nothing is removed, and the bridge claims Serve alone.
- **The converters' `deviceJoined` and `deviceInterview`,** delivered as zigbee2mqtt delivers them:
  `deviceJoined` on herdsman's own (the converters' common hook; the device has no definition yet),
  and `deviceInterview` on each of herdsman's statuses (`started`, `successful`, `failed`), its
  `successful` after the definition is resolved and the device described, with the definition's own
  hook. Each runs in its event's exchange, as the device's other hooks do; none under the owner's
  switch. These two open no answers in practice: at `deviceJoined` and at the interview's `started`
  herdsman's model has no manufacturer yet, so the converters' common hook sets a read handler (a
  Legrand device's) only after a successful interview, and the hooks are delivered for the
  converters' own state, not for answers.
- **Green Power devices** commission in every window: herdsman's permit also opens Green Power's
  commissioning mode, and herdsman admits a Green Power device without the join handler
  (`onDeviceJoinedGreenPower` never asks `acceptJoiningDeviceHandler`), so without `mayAdmit` or the
  window rule; a known Green Power device re-commissioned in a window raises nothing. The core's
  guards still apply: blocked hardware is turned away (`keepsOut`), and admissions are held while the
  store is away (plan 3b review M3; backlogged).
- **A router** is a device whose herdsman `type` is `Router`: its description says `router: true`,
  so a window can open at it (`near`).
- The departure from the standard: bridge.md's *Provisioning* says "a secured rejoin sends no
    `joined`, even while a window is open". herdsman cannot tell one from an association, so a
    router that rejoins during an owner's window comes back new, and evicts the adopted device.
    Named for the bridge standard's next revision.
- **The blocklist** is the core's (*The doer port*): the join handler asks `mayAdmit`, as above,
  and a refusal makes herdsman send a Leave Request without rejoin, which removes the hardware at
  once (GA-BRIDGE-27). Blocked hardware herdsman still has (a removal waiting for a silent device)
  is turned away the same way when it comes in inside a window, and outside one a secured rejoin of
  it keeps the device, whose removal is still pending.
- **`remove`:** `device.removeFromNetwork()`, which deletes the device from herdsman's database once
  it answered, then `left`; herdsman raises no `deviceLeave` for it. Without `force`, a device that
  does not answer (any rejection but the device's own ZDO status) is tried again at its next message
  or announce, one try at a time, and `remove` stays pending until the device is out; herdsman's own
  `deviceLeave` of it (the Leave reached it after herdsman gave up) ends it too. The device's ZDO
  status (`Zdo.StatusError`) rejects `remove`: the doer cannot remove it, and the core keeps the
  removal under `remove_refused`. With `force`, the device is dropped from herdsman's database
  without a frame (`removeFromDatabase`): it still believes it is in the network and holds its key,
  and comes back as new hardware (`joined`, new id), in a window or not, unless blocked (herdsman
  marked it deleted; a secured rejoin needs no permit). A forced removal ends any removal of the same
  hardware still waiting. A removal asked while no controller is up waits for the next: one without
  `force` is tried once it is up; one with it drops herdsman's record as the controller resumes,
  before it describes its devices, so the device is not described and admitted anew (plan 3b review,
  gap c). Hardware herdsman does not have is reported `left` at once.

### The store (`store.ts`)

Postgres schema `bridge_zigbee`, its own role, as the storage design gives every build:
- `devices`: `device_id`, `hardware_id`, `admission` (a counter, so that a re-admission gets a new
  id), `present` (false once it left or was removed; rows are never deleted, so no id is given
  twice), `last_check_in`;
- `blocked`: `hardware_id`, `since`, the hardware id being the `stableIdentifier`;
- `settings`: `device_id`, `key`, `value`, `observed_at`. These are the last observed values of
  the settings that drive re-description, kept across restarts (GA-BRIDGE-74);
- `meta`: the coordinator's IEEE address and the `network.json` checksum.

What it does not hold:
- herdsman's own `database.db` and the coordinator backup. Those stay files in the private data
  directory, since herdsman takes paths.
- The network key, which never goes to Postgres.

The install's nightly dump covers the schema. The data directory is backed up by
`zigbee-bridge backup`, by the owner.

A store fault stops the bridge's writes, not its serving: a `store_fault` fault in the status, and
commands, statuses and the roster served from memory, as the applier's ruling does for the applier.
`lastCheckIn` lost in a crash between saves is the cost, as in the PC bridge's `SAVE_MS`.
**What must survive a restart is never done from memory** (GA-BRIDGE-27, 31, 35):
- while the store is down, `join`, `remove` and `unblock` are answered `failed(store_fault)`;
- an open window is closed;
- unknown hardware that arrives anyway is not admitted: the doer refuses it in
  `acceptJoiningDeviceHandler`.

### The scripted doer and the harness

**The scripted doer** implements the port from the test-control topic, as the PC bridge's scripted
OS does. It runs only under `GALATEA_TEST_TRANSPORT`, with mutations only under a run id.

**New test-control ops** (`harness/test-control.json`):
- `describe`, a device's entry, which can change its declarations;
- `occur`;
- `undescribed`;
- `admit { how }`, `leave`, `windowState`;
- `protocolResult`, to script what the next `execute` returns;
- `setting`, an observed setting with re-description.

The other bridges' backends answer each `unsupported`, as the PC's already do.

For Provision (plan 3a): hardware the scripted network does not have in it (new, left or removed)
that a `describe` or an `admit` brings in is asked about first (`mayAdmit`), and a refused one stays
out. So is an `admit` of hardware it has as an `association` or a `tcRejoinWellKnown` (the harness
names the kind, so the scripted doer need not model the window rule), and a refused one is turned
out, reported `left`, as herdsman's Leave Request does. A window the doer opens or closes is shown on `received` as
`{ device: <near's hardware, or "*">, action: "provision.window", args: { windowMs } }`, `windowMs` 0
for a close. A `describe` entry's `router: true` makes a device a router. `windowState` is not played:
the scripted network opens no window of its own.

**The harness gains an applier-side seam.** It publishes `devices/{d}/command` with `issuedAt`,
`resultWithinMs` and Message Expiry, and `request/{op}` with 10 s expiry, and reads acks, replies
and events. Today it has none (*Gaps* in the prep notes), and every bridge build will use it.

**Harness tests** cover each Serve and Provision id this bridge claims that has none yet. They are
written in the plans that build the behaviour, with the negative subjects that arm them (bridge
0.5's *Negative subjects*). Two negatives deferred at the review land here: occurrence
de-duplication, and a safety rule reading an event key (the latter in the applier's harness).

### The install

Plan 4a puts the bridge into the installation's Compose file (`reference/install/compose.yaml`),
beside the store. Nothing in it assumes a box: the broker, the store and the coordinator are
settings, so the same image runs in this stack now and on another box once the installation has
its certificate authority (the maintainer, 2026-10-06).

- **One list of builds.** `instances` already gives each build a role and a schema in Postgres.
  It also gives each one a broker identity of the same name, with its own password in
  `secrets/broker/<id>`, written by `bin/galatea-db-prepare` beside the store's. The Zigbee
  bridge's line is `bridge_zigbee`, so its bridge id, its broker user and its schema are one name.
- **The broker** is the stock `eclipse-mosquitto:2` image, MQTT 5 by default. No anonymous client;
  passwords hashed at each start from the secrets into a file only the broker reads; persistence on,
  so a broker restart keeps the retained statuses (the lesson that a broker without it drops
  every retained message). Its access rules: `applier` reads and writes everything under
  `GALATEA_ROOT`; every other identity reads and writes only `{root}/bridges/<its id>/#`, which is
  every topic a bridge uses. This is not Box: the grants are not the owner's per reader
  (GA-BOX-1, 2). No port is published; builds reach it as `broker:1883` on the stack's network.
  TLS, and access from other boxes, wait for the certificate authority, as the store's do.
- **The bridge's image** is built from the repository (`reference/zigbee-bridge/Dockerfile`):
  Node 24, the workspace packages it needs built, and `pnpm deploy` of the bridge with its
  production dependencies only. The build context is an allow-list (`.dockerignore`), so nothing
  outside the packages it needs, ignored files included, reaches the image.
- **The bridge's service** (`zigbee-bridge`, under the Compose profile `zigbee`, so an
  installation without a coordinator never starts it) runs as the owner's `GALATEA_UID`, which owns
  its data directory (`${GALATEA_ZIGBEE_DATA:-./zigbee}`, made mode 0700 by
  `bin/galatea-db-prepare` when `bridge_zigbee` is listed, since Docker would make a missing one as
  root). It waits for `db-init` and the broker. `stop_grace_period` is 45 s, over the stop's 30 s
  backup bound (plan 2c-3), and `init: true` passes Docker's SIGTERM to the bridge.
  `GALATEA_ZIGBEE_COORDINATOR` and `GALATEA_ZIGBEE_NO_ACTIONS` come from `.env`.
- **Passwords from files.** The bridge reads its broker password from `GALATEA_CREDENTIAL_FILE`
  (as the PC bridge does) and its store's from `GALATEA_DATABASE_PASSWORD_FILE`, which fills the
  password into `GALATEA_DATABASE_URL`. Each file must be the bridge's account's alone (mode 0600),
  and neither password is ever printed. Both are optional, so the harness and the bench runs that
  pass neither work as before.
- **The owner's commands.** `form` and `backup` refuse while the bridge runs, and see its lock only
  in its network namespace (plan 2c-3, review M6). Run through `docker exec` they would always meet
  the running bridge and refuse, so `bin/galatea-zigbee form ...` and `bin/galatea-zigbee backup`
  refuse while the service runs, then run the command in a one-off container of the bridge's image
  on the same data directory (`docker compose run --rm --no-deps`). `backup` writes to
  `backups/zigbee/`, beside the store's dumps, which the store's pruning leaves alone. A bridge
  started while a command runs is not seen by it; the guide says to stop the service first, and the
  script checks.

### What the bench taught (bridge 0.6)

Plan 5 builds the bridge's side of bridge 0.6 (the bench's lessons,
the maintainer's rulings of 2026-10-06). The standard's text is in review on its own branch; the
plan is built on that branch and follows its fixes.

**The mapping layer** (`describe.ts`, GA-BRIDGE-78). The converters' exposes map to the applier's
keys through one table, data, by what the reading means:

| Converter property | Key | Note |
|---|---|---|
| `presence` | `occupancy` | Radar: someone there now |
| `occupancy` | `motion` | Mostly a PIR, its `false` often the converter's own timer |
| `illuminance` | `illuminance` | lx; `illuminance_raw` and ZCL's log-encoded value are not mapped |
| `contact` | `opening` | By its on-value, as every binary: the converters' `contact` is on at `false` (contact broken), so `opening` is `true` when open, as the bridge already reported it |
| `water_leak` | `leak` | |
| `temperature`, `humidity`, `battery` | the same | |
| `battery_low` | `battery_low` | Tentative in the standard; mapped, since it is a reading |

The override table gains `meaning`, a per-model map from a property to a key, for a radar whose
definition uses the PIR name (`occupancy` → `occupancy`), and the reverse. A `motion` `false`
is the device's own where it sends one; for a PIR that never does, the converter's timer's `false`
(the pipeline's `late` path) is published, since without it `motion` would read `true` for ever, and
the passport records which (GA-BRIDGE-78, as round 3 of the 0.6 review left it). A model whose timer
output is no reading of the device's names the key in `dropLate` (the TS0210's `vibration`). The
passports record each model's mapping.

**Keys held back** (GA-BRIDGE-80). The core holds back a device's read-only keys (its `sensorKeys`,
and extension `state` keys no action confirms) until the device first reports each. The store keeps
which keys each device has reported, so a restart does not hold them back again. A held-back key is
in the entry's `awaitedKeys`, never a reading; on its first report the core publishes `devices`
with it declared, then the status that carries it. A writable key (a setting) stays declared from
the start: it must be, to be set.

**Undescribed data** (GA-BRIDGE-76). The core keeps each device's undescribed names with when each
was first seen, in the store, and lists them in the entry's `undescribed`; the first time it sees
a name it publishes an `undescribed` event `{ device, name }`. The `undescribed_keys` fault goes.
The pipeline knows a ZCL attribute that repeats a reading the definition already maps from a Tuya
datapoint (`genPowerCfg.batteryPercentageRemaining`, `genPowerCfg.batteryVoltage`,
`msIlluminanceMeasurement.measuredValue`, where the definition maps `battery` or `illuminance`):
not undescribed, dropped, and a check-in.

**Kept settings** (GA-BRIDGE-79). The store's `settings` table already keeps the settings that drive
declarations, with their observation time. It keeps every setting the device confirms (a report,
or the echo of a write): every writable key. After a restart the core publishes each kept setting
in the device's status with its kept time, until the device reports it again.

**Not in plan 5a.** Freshness (5b, *Freshness* below): polling an awake device and configuring a
report on a sleeping one, each checked on the bench (a configuration write is a write to the device,
so it waits for the maintainer's go); then the bench's measured intervals. The tentative *Settings* (`configure_device`)
waits for the standard's ruling.

### Freshness (plan 5b)

Every device the herdsman doer describes declares a bound it can stand behind (GA-BRIDGE-13, *The
roster and freshness*: "a bridge whose protocol lets it learn a bound SHOULD use it"). The bench's
three devices had none (*What the bench taught*, lesson 1). Three routes, in this order:

**Polling** (`polling.ts`). A device the bridge reaches within 5 s (`POLL_REACH_MS`, the poll's own
wait) and that serves genBasic is polled: a router, a device on mains, and the button pusher, whose
reach the bench measured at 2.5 s. Its entry says `basis: poll`, `cadenceMs` 300 000 (⚠️ a guess:
"a cheap read every few minutes"), `basisMaxAgeMs` 900 000, three times that.
- The poll is the doer's own read of genBasic's `zclVersion`, never a converter's get: every device
  serves it, a Tuya device answers it though it answers no read of its datapoints, and it changes
  nothing. Its answer is a Read Attributes Response, which herdsman emits as the device's message, so
  it reaches the core through the pipeline as a check-in (GA-BRIDGE-37); an answer with an error status
  is the device's application answering too. A Default Response is no message, so a command's answer
  is no check-in; the poll is a read for that reason.
- It is sent once, at once (`sendPolicy: immediate`, `disableRecovery`), and waited for 5 s at most,
  like configure's calls: on Z-Stack a frame holds the device's place in herdsman's queue, so an action
  on the same device waits behind a poll at most that long.
- The doer polls after each successful health exchange (every 10 s), one device at a time, the
  longest-waiting first, each 5 minutes after it was last heard or polled: a device heard in between
  is not read, its message being the check-in a read would bring. Nothing is polled while the
  coordinator does not answer.
- The poll is the route for an awake device even where its `configure` set a report up: the bridge's
  own read gives the tighter bound, and its reports still check in.
- A model the bench saw answer no poll has `poll: false` in the override table, and reports on its own.

**A configured report** (the override's `reports`). A sleeping device whose definition sets up no
reporting gets one from the table: today the vibration sensor and the radar, an hourly battery report
on genPowerCfg (`BATTERY_REPORT`: minimum and maximum interval 3600 s, change 0; ⚠️ the hour is
HS29's guess, one report an hour of the battery). It runs in `configure`'s run, so at an end device's
next message (it is awake then), with configure's retries: at the device's next message no sooner than
10 minutes after a failure, three tries per version until a restart or an interview.
- Once the device accepted it (its Configure Reporting Response; herdsman records the reporting only
  then), the bound is twice the longest maximum interval, 7 200 000 ms. A refusal or a timeout keeps no
  version and no bound.
- A model the bench saw accept a report and then not report by it has `reportsIgnored` in the table,
  with the date and what was seen: its bound from configured reporting is null, whatever it accepted
  (*The roster and freshness*: "the bridge's maker records that per model").

**A measured rhythm** (`rhythm`). Where no report is configured, a model the bench measured reporting
on its own at a steady interval has `rhythm` in the table, with its date and what was seen; the bound
is twice it, allowing one missed report (*Rulings*). Never a figure the bridge sees at run time. No
model has one yet: the bench's overnight run decides (the coordinator bench guide, *Freshness: polls
and configured reports*).

Otherwise the bound is null, and the applier reads the device `stale` until the owner sets one.

- **A restart** keeps every bound: herdsman's database keeps `meta.configured` and the reporting it
  recorded, so the configured bounds are declared at once and nothing is configured again; a polled
  device is read within one health exchange of the controller's start. The core keeps `lastCheckIn`.
- **Under the owner's switch** (`GALATEA_ZIGBEE_NO_ACTIONS`) nothing is polled and nothing configured,
  since both send a device a frame; every device reports on its own, its bound from reporting it
  accepted earlier, if any.
- **The scripted doer** reads each device its entry declares `poll`, at the entry's cadence, so the
  harness grades the poll's check-ins (GA-BRIDGE-13's test, *Testing*).

### Data flow: one command, end to end

The Fingerbot in switch mode, `onoff.turn_off`:
1. The applier publishes the command. The core de-duplicates it, checks `args` and the deadline,
   then calls `execute`.
2. The doer runs `tz.on_off` through the recording endpoint with `disableRecovery` off, since the
   action is idempotent. genOnOff `off` gets a Default Response with status 0, so the result is
   `confirmed`.
3. The core acks `applied`.
4. The device's `onOff 0` report arrives as `observed`, with `checkIn`. The core publishes the
   status within 1 s (GA-BRIDGE-37). The applier matches it and acks the step.
5. If no report came, the core's read-back (`convertGet` → read genOnOff) fills the gap before the
   ack bound.

A `mode` change to `click` arrives as the Tuya echo. The doer sends `described`, with `onoff` now
not idempotent, and then `observed` with the new `mode`. The core publishes `devices`, then the
status. The applier's next plan sees the press semantics (GA-DESC-18).

## Error handling

| Fault | What the bridge does |
|---|---|
| Coordinator unreachable or half-open | probe fails, transport `down` within 30 s, controller rebuilt on backoff; devices unchanged (the applier makes them `dead`) |
| herdsman start returns `reset` unexpectedly, or a different coordinator answers | `state_mismatch`, everything `down`, provisioning `failed(state_mismatch)` (GA-BRIDGE-12) |
| No `network.json` | `no_network` fault; no form |
| A converter throws on a message | logged, that message's output dropped, the device's other messages unaffected (GA-BRIDGE-9's "one device must not stop the others") |
| A converter throws in `convertSet` | before any call reached herdsman: `notSent` → `failed(unreachable)`; after one: `lost` → `failed(no_confirmation)`, the error as `detail` |
| An unknown model | described by a generated definition (`classEvidence: protocol`); nothing it cannot map is offered |
| The broker goes away | the core's reconnect, as the PC bridge's; no `available` changes (GA-BRIDGE-9) |
| The store is down | `store_fault`; serving continues from memory |

## Testing

- **The core:** vitest over a fake port and `@ludentes/galatea-life-test-clock`, covering every rule above.
  Transcribed tests from the PC bridge's binding where the rule is the same.
- **Graded by the harness:** the scripted doer, as `subject.json`. The build's report is the
  harness's for the ids it claims.
- **The herdsman doer's parts, without a radio:**
  - `describe.ts` and `overrides.ts` against the real converter definitions of the passported
    models, with fake `Device` and `Endpoint` objects;
  - `execute.ts`'s classification against a fake endpoint;
  - `pipeline.ts`'s de-duplication and dropping;
  - the network guard against a fake controller.
- **On the bench** (manual, a guide in `docs/guides/`): form a network, pair the TS0210 and the
  Fingerbot, and walk the passports' behaviours through the bridge, cable pull included.

## Spikes the plans run first

Each has the four fields, a time-box and a second reader, as `spike` requires, and is written in
its plan:
- **S3: the coordinator link.** Does herdsman notice a pulled cable before our probe does? This is
  the bench spike's unfinished third question.
- **S4: preventing the silent reset.** Can the doer know before `start()` that herdsman would form
  a new network?
- **S5: the confirms dry run.** Does every passported definition's `convertSet` run against a
  recording endpoint and reveal its answer path?
- **S6: rejoin kinds.** Which of the four admission kinds can the Z-Stack adapter tell apart?
  Answered from the sources in plan 3a (2026-10-05): none by any frame; only herdsman's deletion
  and the doer's own window (*Provisioning*). Which rejoin an indication outside a window is could
  not be found out without a sniffer; the bench procedure is in the bench guide's second part, now
  the window rule's check.

## Plans

The build is split so that each plan ends graded and merged:
1. **The Serve core over the scripted doer.** The package, store, wire, core, scripted doer, new
   control ops, the harness's applier-side seam, and the harness tests and negatives for Serve,
   GA-BRIDGE-74 to 77 included. Admission ids and leaves (GA-BRIDGE-21, 35, Serve-level rows) are
   in the core here, driven by the scripted doer's `admit` and `leave`; windows, removal and the
   blocklist wait for plan 3.
2. **The herdsman doer.** Spikes S3 to S5, the network guard, the link, the pipeline, `describe`,
   overrides, `execute`, the CLI, and the bench guide for Serve on the TS0210 and the Fingerbot.
3. **Provision.** Split in two:
   - **3a:** spike S6, the core's windows, blocklist and removal over the scripted doer, the
     scripted doer's share, the harness tests and negatives, and Provision claimed. The requests'
     and events' fields are checked by the core itself; no schema is added.
   - **3b:** herdsman's join, close and remove (`provision.ts`), `near` at a router, the
     converters' `deviceJoined` and `deviceInterview`, the window closed before the doer stops, the
     window rule's classification and the re-description under a new id, `provisions` true, and
     the bench guide's checks.
4. **Install and first light.** Split in two (the maintainer, 2026-10-06):
   - **4a, the bridge installed:** its image, the broker, its role and identity, its service and
     the owner's commands in the installation's compose (*The install*), checked by throwaway stacks
     and by a read-only run against the real coordinator.
   - **4b, first light:** a model switches the Fingerbot (or a Zigbee lamp) through steward,
     applier and bridge. It waits for the applier and the steward to be packaged, for the
     maintainer's choice of the box the stack runs on, and for their lifting of the bench's
     no-command rule for that one device.
5. **What the bench taught (bridge 0.6).** Split in two (*What the bench taught*):
   - **5a:** the mapping layer, held-back keys, undescribed data as an event and a list, kept
     settings, over both doers, with the harness's tests and negatives for GA-BRIDGE-76, 78, 79
     and 80.
   - **5b:** freshness (*Freshness*): polling and configured reports over both doers, with
     GA-BRIDGE-13's test grading the poll; the bench's checks and its measured intervals wait for the
     maintainer's go.

## Rulings (provisional, for the maintainer to overrule)

- **Forming is explicit,** a CLI act of the owner's, never automatic. A missing config is a fault.
- **The extension namespace** is `org.galatea.zigbee.<definition slug>`.
- **No manifest** in this build: Find, `bridgeType` and `connections` come with the finder work.
- **Pins:** herdsman 10.10.0 (≥ 10.9.6 for coordinator-only join), converters 26.114.0, Node 24,
  pnpm with herdsman de-duplicated by an override.
- **No coordinator queue:** `sendPolicy: immediate`. `reachMs` is the device's poll interval, and an
  action is withheld where that is unknown or over 145 s.
- **`toggle` is never offered,** even where a converter supports it.
- **The bench network** (PAN 32416, a random test key) is wiped before plan 2's form. The sensor
  and the Fingerbot are re-paired then.
- **`contact: true` means closed,** as the converters have it. The applier standard's gap is
  recorded for its next revision.
- **Admission without a rejoin flag: the window rule** (the maintainer's ruling, 2026-10-05, on
  S6's answer). An indication for hardware herdsman still has is a new admission (a new id) while a
  window the doer opened is open, and a rejoin (the same id) outside every window. This amends the maintainer's
  earlier 2026-10-05 ruling (a re-association of hardware herdsman still has keeps its id) for
  arrivals inside a window; outside windows that ruling stands. It matches the standard's own limit
  ("any joiner in a window that claims an adopted identifier evicts the real device") and closes the
  impostor case outside windows; it departs from the standard's "a secured rejoin sends no
  `joined`, even while a window is open" (*Provisioning (`provision.ts`)*). `withholdsPins` stays:
  no lock gets its PIN until the maintainer has seen the bench check of S6's procedure.
- **`near` is offered,** and a window without it is house-wide (herdsman's broadcast), as the
  standard's `join` reads ("at the router `near` names if the transport can, else house-wide").
  A window on the coordinator alone is not offered.
- **A device's `stableIdentifier` is its IEEE address,** which is the doer's hardware id, so the
  blocklist and `remove { identifier }` name hardware the way the store keeps it.

- **Freshness** (plan 5b's spike, for the maintainer's review; *Freshness*): a device in reach polled
  with a genBasic read every 5 minutes, never a value read; the poll before a configured report for a
  device that is awake; an hourly battery report configured on sleeping sensors whose definition sets
  up none; a model's measured interval doubled, as a configured one is ("allowing at least one missed
  report", which the standard leaves open for a model's figure; the harness takes both); a figure, an
  ignored report and an unanswered poll recorded per model, with the bench's date, never learnt at run
  time; hardware admitted anew configured again.

## Not in this build

- Box (broker identity and grants) and Find (manifest, finder).
- Install codes (the standard says SHOULD; no device in the flat has one).
- Group commands and scenes.
- OTA updates.
- Binding-table reads for `otherAdmins`: `unknown` throughout, which GA-BRIDGE-14 allows.
- Occurrence coalescing (deferred at the review: measure first).
