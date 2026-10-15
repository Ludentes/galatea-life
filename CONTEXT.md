---
title: Galatea Home — vocabulary
status: draft
last_verified:
area: architecture
audience: dev, pm
author: Galatea maintainers
---

# Galatea Home — vocabulary

A glossary, nothing else. Each term says what it means here and what not to call
it.

**Brain**:
The resolver, the LLM and voice arbitration together. Decides what a person meant
and asks the steward to do it. Holds no home state of its own.
_Avoid_: assistant (the product), agent, controller

**Resolver**:
The deterministic part of the brain. Turns an utterance into actions, or asks, or
refuses. Runs first; the LLM gets only what it refuses or asks about.
_Avoid_: parser, NLU, intent engine

**Steward**:
Anything that implements the Galatea steward standard. Holds the house on its
owner's behalf: rooms, names, groups, persons, endpoints, scenarios, rules,
schedules, leases and occupancy. Decides who may do what, asks people to confirm,
and keeps the audit of why. Talks to exactly one applier.
_Avoid_: hub, controller, orchestrator

**Client**:
Whatever calls a steward or an applier with a registered credential: a brain, a
panel or an app calls the steward; a steward, or a meta-applier for its child,
calls an applier.
_Avoid_: caller, user

**Applier**:
Anything that implements the Galatea applier standard. Owns devices, plans and
applies actions, reports outcomes and liveness, and runs safety rules. Knows no
persons, rooms or routines.
_Avoid_: executor, hub, controller, engine

**Meta-applier**:
An applier whose devices belong to child appliers, and which routes to them. It
holds no house state. The open-source reference applier is one.
_Avoid_: proxy, aggregator, gateway

**Child**:
An applier, or an adapted engine, under a meta-applier.
_Avoid_: backend, sub-hub

**Adapter**:
Code that makes a non-conforming engine (Home Assistant, Sprut.hub) look like an
applier to a meta-applier, at the levels it can honestly reach.
_Avoid_: integration, connector, plugin (reserved for a PC's package)

**Bridge**:
The doer below an applier: a process that speaks to one or more transports and
to its applier over the MQTT binding of the Galatea bridge standard. It reports
what devices say and carries out commands; it knows no persons, tiers, plans or
tokens.
_Avoid_: driver, integration, adapter (reserved for a non-conforming engine)

**Transport**:
What a bridge fronts devices over, and the unit of shared fate: a Zigbee
coordinator, a Matter fabric, an IR blaster, a Modbus gateway. When it is down,
every device on it is dead. A transmitter that can answer nothing (a bare IR LED)
is `unknown`, never up, and its devices stay usable.
_Avoid_: network, hub, radio

**Open loop**:
A device that never reports its own state (`feedback: open`), such as an IR
appliance: its commands end `sent`, never `acked`, and only a witness can say what
one did.
_Avoid_: dumb device, one-way device

**Assumed reading**:
A value the applier derives from the last command it sent to an open-loop device,
marked `assumed: true`. Never an observation: no condition, trigger or latch holds
on one, and a brain says it as what was last sent.
_Avoid_: state (alone), optimistic state, reading (a reading is what a device reported)

**Toggle code**:
A code that reaches a state only from a known one: one that flips it (an IR power
code), cycles it (a mode button) or steps it (vol+). Its action is declared
`toggles: true`; on an open-loop device it is never sent to reach a state without a
person's yes, and the applier never sends one of its own.
_Avoid_: button (no action presses one), switch

**Liveness**:
The applier's verdict on whether a device is still there: `live`, `stale` or
`dead`. A bridge reports facts (what a device said, when it last checked in,
its bound or that none is known); the applier judges them, because only it knows
whether the bridge itself is alive, the owner's bound, and the devices no bridge
serves. Every consumer reads the verdict from the applier, through the steward,
and never rebuilds it from a bridge's roster.
_Avoid_: online, offline, available, for a device's liveness (a bridge's `available` is the
protocol's own fact that a device left; a bridge's own `status.state` keeps `online` and `offline`)

**Finder**:
The one process on a box that listens for devices on the home's network and the
box's own ports (mDNS, SSDP, DHCP, Bluetooth, USB) and reports what it heard. It
asks only discovery questions, and never connects to a device.
_Avoid_: scanner (suggests probing), discovery service

**Candidate**:
Something the finder heard that a bridge's manifest matches: not yet a device.
It becomes one only when a bridge takes it and lists it, and is usable only once
the owner adopts it. At Box, only the owner's app sees candidates.
_Avoid_: device, discovered device, new device (a new device is one a bridge
already holds, unadopted)

**Manifest**:
A bridge type's `galatea-bridge.json`: what it can take, as matchers the finder
reads, shipped whether or not the bridge runs.
_Avoid_: confusing it with the requirement manifests under [`conformance/`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance)
(`<standard>-requirements.json`), which list a standard's requirements

**Adoption**:
The owner's act that makes a new device usable, giving it a class. Until then a
device is visible and inert, whoever joined it.
_Avoid_: pairing (the radio's join), inclusion, onboarding

**Other admin**:
Another ecosystem's controller of a device: a phone's Matter fabric, a bound
Zigbee remote. Shown on the device, and a notice when it could open a door.
_Avoid_: controller (kept for our own components), co-owner

**Target**:
A thing an action is applied to: a device, a group or a channel. Rooms are reached
through a **selector** (room, class, capability), which the steward resolves.
_Avoid_: entity, item, thing, endpoint (reserved)

**Endpoint**:
A place a person talks to or presses: a voice satellite, a panel or an app. It has
a room, and may be served by a brain. A request's `via` is its endpoint's type.
Not a target: nothing is applied to it.
_Avoid_: terminal, device

**Front**:
How utterances reach a brain and its replies reach people: `listen`, `say` and
`hush`, text only. A voice front, a chat window or the conformance harness sits
behind it.
_Avoid_: UI, frontend

**Voice front**:
The front that hears and speaks: device links, listening modes, wake words, speech
recognition and synthesis, merging, echo marking. Audio in, text out, no house
concepts; it controls no device.
_Avoid_: voice assistant, pipeline (it has several), satellite (one of its devices)

**Utterance**:
What a person said at one endpoint, as text: `{ utterance_id, endpoint, time,
available_at, transcript, speaker_hint?, echo? }`, and from a voice front also how
it was addressed, its conversation, its source and the other endpoints that heard
it. One sentence heard by two satellites is two utterances, unless the voice front
merged them into one.
_Avoid_: command (not every utterance is one), intent

**Zone**:
Endpoints whose microphones hear each other. A conversation lives in one zone, and
merging is decided within it; echoes are decided across the home. Not a room: one zone may span two.
_Avoid_: area, room

**Listening mode**:
What an endpoint may hear: `off`, `tap`, `wake_device` (the device's own wake model
opens a window) or `wake_server` (speech streams to the box, which checks the wake
word). Ordered by what leaves the room. The owner's is configured; the effective one
is that, narrowed.
_Avoid_: privacy mode, mic setting

**Narrowing**:
A temporary cut to an endpoint's listening, from anyone there, a guest or visitor
included; at most 12 h. Narrowings stack; only the owner lifts one or widens. A
device's mute button is not one: it is the voice front's own, and lifts when
released.
_Avoid_: mute (the button), pause

**Addressing**:
What opened an utterance: the wake word, a tap, a follow-up window, a skill session
or typing. The voice front decides it, except that a tap and a device's own wake are
the device's word, which the front confirms where it can.
_Avoid_: trigger (reserved for rules), activation

**Follow-up window**:
A short time after an invited reply in which an endpoint takes speech without the
wake word. Off by default; turning it on widens listening. A follow-up yes counts only
with a speaker model's hint naming the speaker.
_Avoid_: continued conversation, open mic

**Conversation**:
Utterances and replies in one zone joined by follow-up windows. The voice front
holds its mechanics; the brain holds what it means.
_Avoid_: session (a skill's), dialogue (the confirmation's)

**Echo**:
The house's own speech heard back by a microphone. Marked only when its time
overlaps a playback and its text matches; a barge-in is a person. A known machine's
speech, marked the same way, is `source: machine`. Both are data.
_Avoid_: feedback, loopback

**Data**:
Anything a brain reads that is not an utterance: calendar entries, messages, web
pages, device labels, `history` text. It informs a brain and never instructs it.
_Avoid_: context, input

**Selector**:
A description of targets (room, class, capability) that the steward resolves to
ids.
_Avoid_: wildcard, query, filter

**Channel**:
A target that reaches a person outside the room: a phone push, a Telegram chat.
_Avoid_: notifier, sink

**Room**:
A place in the home. A target belongs to at most one.
_Avoid_: area, zone, location

**Group**:
A named set of targets actuated as one, with an aggregate state. Not a room.
_Avoid_: scene, collection

**Action**:
Something an applier can be asked to do to one target, from a closed vocabulary.
_Avoid_: command (the wire message), service, intent

**Setting**:
A value that configures a device rather than acts on the house, and changes only when written: a
sensor's sensitivity, a button pusher's mode. Its bridge lists it, and keeps a confirmed value across
restarts (bridge 0.6). Changed by the owner at the device's next check-in (⚠️ tentative).
_Avoid_: action, option, parameter

**Awaited key**:
A numeric measurement a device's model promises, and its bridge's maker has seen missing, that the
device has not yet reported; its bridge holds it back until it does (bridge 0.6).
_Avoid_: missing key, pending key

**Tier**:
How much assurance an action needs before it runs: `reversible`, `confirm` or
`no_voice`. Safety is not a tier; it is a property of a rule.
_Avoid_: risk level, permission

**Plan**:
What a steward or an applier would do for a request, target by target, without
doing it. Each step is an operation, a skip, an ask (the steward's only) or a
refusal.
_Avoid_: preview, dry run (as a noun)

**Outcome**:
What happened to one target when a plan was applied.
The first is `dispatched`: the broker took the command. Later ones say what the
device did (`acked`, `delivered`, `sent`, `unanswered`, `failed`), or that it could not be
reached (`unreachable`).
_Avoid_: status; and ack, which is the bridge's word about a command, from which
the applier derives the outcome; `applied` as an outcome (it is the bridge's ack)

**Ack**:
The bridge's one terminal answer to a command: `applied` (the protocol confirmed
it), `sent` (transmitted, and nothing can confirm it), `failed` with a reason, or
`unsupported`.
_Avoid_: result, reply (a reply answers a request that is not a command)

**Scenario**:
A named, authored sequence of actions, run as a unit, with a mode.
_Avoid_: routine, automation, macro, script

**Rule**:
A trigger, optional conditions and actions, resident in the steward and run by it;
or conditions and actions alone, a **rule of conditions only**, which fires each
time the conditions become true together (a time window, a session not locked).
Its **exceptions** are periods in which it does not fire.
A **safety rule** is resident in the applier nearest its devices, and runs even
when everything above it is down.
_Avoid_: automation, flow

**Schedule**:
A time trigger for a scenario, with **exceptions** (dates on which it is skipped or
moved).
_Avoid_: timer, cron

**Lease**:
A claim by a holder that, for a while, lower-precedence writers may not change a
target, with named exceptions: `session.lock` and a narrowing action (a lock, a valve's close) pass a person's hold, and the owner's work may pass a guest's hold once its floor has passed, or any person's where the owner set a switch (a rule's, a device's or the home's). A narrowing action takes no lease and replaces no person's hold; a lower lease it displaces, such as a run's, ends, leaving the device with none. A
**person's hold** is the lease a person's change takes: one made at an endpoint,
an `external` change, or a press.
_Avoid_: lock, ownership; "hold" alone for any lease but a person's

**Hold policy**:
How a person's hold ends: its windows after an on, an off and any other change,
counted once the room goes quiet; whether presence renews it, vacancy or a schedule
ends it; the window for a device with no presence source, the heater's guard after
a load cap, and a cap on every hold (`cap_s`); and whether the owner's work passes a
guest's hold, or every person's. The steward's own, declared in `describe` as the home's `hold`;
the owner may change it.
_Avoid_: hold time, timeout

**Press rule**:
A rule whose trigger is an occurrence its author marks as a person's physical act
(`press`), such as a wall button. It acts at a person's precedence and takes a
person's hold, while staying the rule's for its confirmation and the applier's gate.
_Avoid_: button rule, manual rule

**Via**:
How a request arrived: voice, panel or app (the endpoint's type), or a rule or a
schedule. Never asserted by a brain. With whether a brain served it, decides whether
a `no_voice` action may run.
_Avoid_: channel (reserved for a notifying target), source

**Infrastructure device**:
A device that powers or carries the home's own equipment (the hub, a bridge, a
coordinator, a satellite). Reached only by its id, never by a selector.
_Avoid_: critical device, system device

**Principal**:
Who an action is on behalf of: a person at an endpoint (with a role from the
steward's registry), a scenario run, a rule, or the outside world.
_Avoid_: user, actor, caller

**Visitor**:
The role below guest: may ask, hear answers and narrow listening, and act on
nothing. Comes only from an endpoint's `max_role`: a museum hall, a hallway guests
pass, a skill anyone on an account can speak through.
_Avoid_: anonymous, public user

**Cause**:
What produced a state change: an apply, a scenario run, a rule, a safety rule, a
load cap, the device's own word (a key it declares self-changing, or a key's first
value: no hand can be told from it), or an outside system (a person at a physical
control included).
_Avoid_: source, origin, trigger (reserved for rules)

**Confirmation token**:
The steward's proof, to the applier, that a person said yes to one exact action,
or that an owner authored it outside a brain.
Bound to the target, action, arguments, `via`, `brain` and `for`; short-lived; used
once.
_Avoid_: permission, grant

**Latch**:
A safety rule's hold on its own undo: the valve stays closed until the leak is
gone, and then opens only with a person's confirmation.
_Avoid_: lock (a device class), interlock

**Load**:
What is plugged into a socket: heating, a motor, lighting or other. A heating load
is capped in how long it may stay on.
_Avoid_: appliance, consumer

**Plugin**:
A package on a PC with a manifest, an MCP server and an optional skill, hosted by
the PC's bridge. Installed by the owner and pinned: its devices arrive unadopted,
and adopting one is the owner's approval. The applier sees an ordinary bridge.
_Avoid_: integration, extension (reserved for namespaced capabilities)

**Host**:
A bridge's conformance level for plugins: `install`, `uninstall`, the manifest and
the hosting floors that pin and check their servers. Independent of Provision: a
PC's bridge claims Host and not Provision, a Zigbee bridge the reverse.
_Avoid_: server (a plugin's MCP server), machine

**Computer**:
The device class of a PC: the device a PC's bridge reports for its own host, with
its sessions, power actions and wake path; a plugin's devices hang off it.
_Avoid_: PC (fine in prose, not as the class), host (a level), desktop

**Session**:
A logged-in OS account on a computer, read as its `session.<account>` key, and
mapped to a person by the steward, in the computer's `account_persons` (apart from
the applier's `accounts`, which gives each account's token and label). An account
mapped to nobody, such as a kiosk account, belongs to nobody the house knows.
_Avoid_: user (a person), login

**Session helper**:
The PC bridge's process in one user session, running as that session's user: it
tells active from idle, reads the personal keys and shows notifications. Bound to
its session by the OS, never by its own word. Believed for `active` and `idle` only,
never about a lock, a disconnection or a logout.
_Avoid_: agent (an adapter's remote program), tray app, client (reserved)

**Administrator**:
An account with the OS's administrator rights on a PC, or rights equal to them,
directly or through a group (Windows' local Administrators and Backup Operators;
on Linux root, sudo's all-command accounts, polkit's administrator identities,
the `docker` group); the bridge standard's *The PC's administrators are other
admins* is the definition. It can stop the PC's bridge, so it is one of that
PC's other admins.
_Avoid_: owner (the home's role), admin (alone), root (one Linux case)

**Wake path**:
The device, usually a wake relay's entry, that can wake a computer: its
`wake_via`. A computer without one offers no `power.wake`.
_Avoid_: Wake-on-LAN (one way of waking), wake relay (the device that usually
provides it)

**Personal key**:
A state key that says what a person is doing, marked `personal`: a computer's
session keys, and `app`, `camera_in_use`, `microphone_in_use` and `speech` on every device
that reports them. The applier only marks it; the steward withholds its value, and
its `state` events, from a guest or a visitor and from a brain's read that names no endpoint.
_Avoid_: personal reading, private key (a credential), sensitive data
