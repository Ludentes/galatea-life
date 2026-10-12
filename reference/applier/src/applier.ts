import { randomUUID } from "node:crypto";
import { validate, type ApplierPlan } from "@ludentes/galatea-life-schemas";
import type { Clock } from "./core/clock.js";
import { copyConfig, emptyConfig, loadConfig, modelKey, saveConfig, type Config, type Level } from "./config/config.js";
import { brokerAdmins, claimsOf, declarationFault, dropTiers, fallenTiers, IGNORE_KINDS, loadIn, planChanges, type Change } from "./config/configure.js";
import { RequestError, StoreUnavailable } from "./core/errors.js";
import { hashSecret, OWNER_CREDENTIAL_MIN_LENGTH, sameSecret } from "./core/secret.js";
import { storable } from "./core/canonical.js";
import { EventLog, SEQ_LIFE_GAP } from "./core/events.js";
import { Notices } from "./core/notices.js";
import { SerialQueue } from "./core/queue.js";
import { GATE_MS, getMeta, raiseMeta, RisingMeta, setMeta, within, type Store } from "./core/store.js";
import { distinct, planSteps, type Gate, type Requested, type Step } from "./gate/plan.js";
import { sets } from "./gate/actions.js";
import { Dispatcher, type Claim } from "./dispatch/dispatcher.js";
import { forgetAssumed } from "./dispatch/records.js";
import type { BusPort } from "./bus/port.js";
import { quiet, type Log } from "./core/log.js";
import { Home, type HeldDevice, type HeldTransport } from "./model/home.js";
import { forgetDevices, forgetTransports, placeDevices, repointDevices, saveDevices, saveTransports } from "./model/rows.js";
import type { DeviceInfo } from "./config/configure.js";
import { Mutant } from "./mutations.js";
import { SafetyRules, saveSeen } from "./safety/engine.js";
import { LoadCaps } from "./safety/caps.js";
import { Witnesses } from "./safety/witnesses.js";
import { DEFAULT_MAX_ON_S } from "./model/declarations.js";
import { actuated, devicesOf, type SafetyRule } from "./safety/language.js";
import { Provisioner } from "./provision/provisioner.js";
import { Finder } from "./provision/finder.js";
import { Discovery, type Listed } from "./provision/discovery.js";
import type { ApplierService, Caller, ToolResult } from "./service.js";
import { OWNER_TOOLS, CLIENT_TOOLS } from "./tools.js";
import { STANDARD_VERSION, PLAN_EXPIRY_MS, MAX_PLANS_PER_CLIENT, PRUNE_EVERY_MS, OTHER_ADMINS_SAID, COMMAND_NAMESPACE, TICK_MS, asDevice, disabledKey, idempotencyBody, modelEvents } from "./applier-helpers.js";
export { STANDARD_VERSION, PLAN_EXPIRY_MS, MAX_PLANS_PER_CLIENT, idempotencyBody } from "./applier-helpers.js";
export { TOOLS } from "./tools.js";

export type { ApplierService, Caller, Tool, ToolResult } from "./service.js";
export type { BusPort, Puback } from "./bus/port.js";

export interface ApplierOptions {
  store: Store;
  clock: Clock;
  ownerCredential: string;
  applierId: string;
  runId?: string;
  /** The mutation under the harness, as flags (`mutantOf`); `Mutant.none` by default. */
  mutant?: Mutant;
  /** The levels this build can claim; it claims Safe only while the owner's `box` is set and no bridge declares an `ungoverned` path (GA-DESC-6). */
  levels?: Level[];
  /** Its own broker connection is plain TCP to a host off loopback: `box: true` is refused (GA-DESC-6). */
  plainOffLoopback?: boolean;
  retarget?: (source: string) => Promise<void>;
  bus?: BusPort;
  /** Where the applier logs what no caller is told (default: nowhere); the entry point gives stderr. */
  log?: Log;
}

export type Args = Record<string, any>;

export class Applier implements ApplierService {
  readonly mutant: Mutant;
  /** The owner's changes, one at a time, each until its commit (the storage design). */
  private readonly owners = new SerialQueue();
  private readonly log: EventLog;
  private readonly levels: Level[];
  private config: Config = emptyConfig();
  /** The model's revision, as last committed. */
  private rev = 0;
  /** Bearers once accepted as a client: kept only under `session-outlives-revocation`. */
  private readonly remembered = new Map<string, string>();
  private pruneTimer?: number;
  private tickTimer?: number;
  /** The broker's hosts and their administrators as last judged, each `os` entry by its label, `unknown` as itself (GA-SAFE-6). */
  private brokerSeen = new Map<string, Set<string>>();
  /** Where the start is: `load` runs on a new applier only, `resume` on a loaded one only. */
  private phase: "new" | "loading" | "loaded" | "resumed" = "new";
  /** `revision` as `load` read it, before `resume` moves past an unclean stop's. */
  private keptRevision = 0;
  /** Whether a start already told of the devices adopted before GA-ADOPT-3's second door (`load` reads it). */
  private otherAdminsSaid = true;
  /** `revision`, written behind as it moves. */
  private readonly revision: RisingMeta;
  /** The home as the bridges report it: the devices, their facts and their liveness. */
  readonly home: Home;
  /** The notices not yet taken (applier, *Notices*). */
  readonly notices: Notices;
  /** The plans made, by id, until they are long expired; never kept across a restart (`unknown_plan`). */
  readonly plans = new Map<string, { plan: ApplierPlan; expiresMs: number }>();
  /** Apply and dispatch: the applies, the steps waiting, the tokens used. */
  readonly dispatcher: Dispatcher;
  /** The safety rules as they run (applier, *Safety rules*). */
  readonly safety: SafetyRules;
  /** The heating cap (applier, *Loads*, GA-LOAD-2). */
  readonly caps: LoadCaps;
  /** Witnesses (applier, *Safety rules*, GA-WIT-1). */
  readonly witnesses: Witnesses;
  /** Provisioning (applier, *Provisioning*): the owner's requests to bridges, keyed and recorded. */
  readonly provisioner: Provisioner;
  /** The box's finder as the bus hears it (applier, *Discovery*). */
  readonly finder: Finder;
  /** The install's namespace for derived command and run ids (the maintainer's ruling 2), once `load` read it. */
  private commandNamespace?: string;
  /** The applier's log (`ApplierOptions.log`). */
  private readonly say: Log;

  constructor(private readonly o: ApplierOptions) {
    if (o.ownerCredential.length < OWNER_CREDENTIAL_MIN_LENGTH) {
      throw new Error(`the owner's credential is shorter than ${OWNER_CREDENTIAL_MIN_LENGTH} characters`);
    }
    this.mutant = o.mutant ?? Mutant.none;
    this.say = o.log ?? quiet;
    this.levels = o.levels ?? ["Act"];
    this.config.safe = this.levels.includes("Safe");
    this.log = new EventLog(o.store, o.clock, this.mutant);
    this.revision = new RisingMeta(o.store, "revision", () => this.rev);
    this.notices = new Notices(o.store, o.clock, this.mutant);
    // A full disk can last days: the owner hears of it once each time the backlog reaches its cap.
    o.store.onFull = () => void this.notices.raise({ cause: "store", text: "The applier's store has been unreachable so long "
      + "that its writes are dropped: bridges' facts and events are lost until it returns, so history has a gap for this "
      + "time, and after the next start every events cursor expires. Owners' changes and notices wait for it." });
    this.home = new Home(() => o.clock.now(), {
      emit: (type, body, keep) => void this.log.append(type, body, keep),
      modelChanged: (devices, transports) => this.modelChanged(devices, transports),
      transportsGone: (transports) => this.transportsGone(transports),
      // State, written behind: derived again from the bridge's retained document, so droppable.
      factsChanged: (devices) => void this.o.store.write((tx) => saveDevices(tx, devices), { droppable: true }),
      // A snapshot request the broker refused is a fault of the bridge's, raised once (GA-BUS-9).
      snapshot: (bridge) => void o.bus?.snapshot(bridge).then((p) => {
        if (p.kind === "ok" || p.kind === "refused") this.home.published(bridge.id, "request", p.kind === "refused" ? p.code : undefined);
      }).catch((err: unknown) => this.say(`applier bug: a snapshot request threw: ${String(err)}`)),
      ack: (bridge, device, ack) => this.dispatcher.ack(bridge, device, ack),
      reading: (target, key, value, old, basis, changed) => this.dispatcher.reading(target, key, value, old, basis, changed),
      bridgeDead: (bridge, planned) => {
        this.safety.bridgeDead(bridge, planned);
        this.dispatcher.bridgeDead(bridge);
        this.provisioner.bridgeDied(bridge);
      },
      boundChanged: () => {
        this.safety.boundChanged();
        this.witnesses.bounds();
      },
      reported: (target, readings) => {
        this.safety.reported(target, readings);
        if (readings.some((r) => r.key === "on")) this.caps.reported(target);
      },
      declared: (ids) => {
        this.disableRules(ids);
        this.disableWitnesses(ids);
        // A heating load whose turn-off is now a toggle: its cap cannot act (GA-SAFE-13).
        this.caps.judge(ids);
        // A cap stopped by a turn-off now discrete again, or a device back in the model, is armed again (GA-LOAD-2).
        this.caps.rearm(ids);
        this.witnesses.bounds();
        this.safety.boundChanged();
      },
      livenessChanged: (id, old, next) => {
        this.safety.livenessChanged(id, old, next);
        this.caps.livenessChanged(id, old, next);
        this.witnesses.livenessChanged(id, next);
      },
      unaccepting: (id) => [...this.config.rules.values()].filter((r) => r.accepts_other_admins !== true && actuated(r).includes(id)).map((r) => r.id),
      held: () => this.brokerCheck(),
      reply: (bridge, body) => this.provisioner.reply(bridge, body),
      provisioning: (bridge, e) => this.provisioner.event(bridge, e),
      // Never dropped: the bridge does not say a name again, so a lost row would be a name announced twice (GA-DESC-19).
      announced: (bridge, device, names) => void this.o.store.write(async (tx) => {
        for (const name of names) {
          await tx.query("INSERT INTO undescribed_announced (bridge, bridge_device, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            [bridge, device, name]);
        }
      }).catch((err: unknown) => this.say(`applier: an announced undescribed name is not written yet: ${String(err)}`)),
      // Facts, written behind and droppable (the maintainer's ruling K5): the bridge's retained documents give them again.
      connectionsChanged: (bridge, rows) => void this.o.store.write(async (tx) => {
        await tx.query("DELETE FROM connections WHERE bridge = $1", [bridge]);
        for (const r of rows) {
          await tx.query("INSERT INTO connections (bridge, kind, entity, keys) VALUES ($1, $2, $3, $4)",
            [bridge, r.kind, r.entity, JSON.stringify(r.keys)]);
        }
      }, { droppable: true }),
      // What `describe` claims follows a bridge's `ungoverned` (GA-DESC-6): a model change.
      ungovernedChanged: (bridge) => void this.bumpRevision([{ bridge }]),
      notice: (n, key) => void this.notices.raise(n, key),
      clearNotice: (key) => this.notices.clear(key),
      withdrawNotice: (key) => this.notices.withdraw(key),
      standingNotices: (prefix) => this.notices.standingKeys(prefix),
      log: this.say,
    }, this.mutant);
    this.provisioner = new Provisioner({
      store: o.store, clock: o.clock, mutant: this.mutant, home: this.home,
      ...(o.bus ? { request: (b, op, body) => o.bus!.request(b, op, body) } : {}),
      published: (bridge, code) => this.home.published(bridge, "request", code),
      fault: (bridge, what) => {
        this.say(`bridge ${bridge}: ${what}`);
        void this.log.append("bridge_fault", { bridge, what });
      },
      emit: (type, body) => void this.log.append(type, body),
      notice: (n) => void this.notices.raise(n),
      log: this.say,
      listed: () => this.listed(),
    });
    this.finder = new Finder({ clock: o.clock, log: this.say, mutant: this.mutant });
    this.dispatcher = new Dispatcher({
      store: o.store, clock: o.clock, mutant: this.mutant, log: this.say, gate: (client) => this.gate(client),
      namespace: () => {
        if (this.commandNamespace === undefined) throw new Error("applier bug: a command id derived before load read the namespace");
        return this.commandNamespace;
      },
      target: (id, action) => this.home.target(id, action),
      fingerprint: (id, action) => this.home.fingerprint(id, action),
      ...(o.bus ? { command: (b, d, body, expiryS) => o.bus!.command(b, d, body, expiryS) } : {}),
      published: (bridge, code) => this.home.published(bridge, "command", code),
      emit: (type, body) => void this.log.append(type, body),
      stepEnded: (run, i) => this.safety.stepEnded(run, i),
      lateAck: (rule, applyId, target, stepId) => this.safety.lateAck(rule, applyId, target, stepId),
      running: (applyId) => this.safety.runs(applyId) || this.caps.runs(applyId),
      // A latch's undo that ran is the household's again (GA-SAFE-7).
      ran: (target, action, args) => this.safety.latches.ran(target, action, args),
      assumedChanged: (device, keys) => this.safety.assumedChanged(device, keys),
      capEnded: (run, i) => this.caps.capEnded(run, i),
      ended: (target, action, outcome, dispatchedMs) => this.caps.ended(target, action, outcome, dispatchedMs),
      dispatched: (applyId, run, stepId, target, action, args, dispatchedMs) =>
        this.witnesses.dispatched(applyId, run, stepId, target, action, args, dispatchedMs),
    });
    this.safety = new SafetyRules({
      store: o.store, mutant: this.mutant, clock: o.clock,
      liveness: (device) => this.home.gateDevice(device)?.liveness,
      planned: (device) => this.home.deathPlanned(device),
      bound: (device) => this.home.boundOf(device),
      reported: (device, key) => this.home.reportedValue(device, key),
      basis: (device, key) => this.home.reportedBasis(device, key),
      assumed: (device, key) => this.dispatcher.assumedValue(device, key),
      actuate: (ruleId, actions, cause) => this.dispatcher.actuate(ruleId, actions, cause),
      resend: (applyId, i, action, attempt) => this.dispatcher.resendStep(applyId, i, action, attempt),
      action: (device, action) => {
        const t = this.home.target(device, action);
        return t && { idempotent: t.idempotent, ack_within_s: t.ack_within_s };
      },
      landed: (device, action, args, since) => {
        const s = sets(action, args, this.home.target(device, action)?.confirmed_by);
        if (!s) return false;
        const v = this.home.reportedValue(device, s.key);
        return v !== undefined && (this.home.reportedBasis(device, s.key) ?? -Infinity) >= since && s.matches(v);
      },
      run: (applyId) => this.dispatcher.heldApply(applyId),
      takeUp: (applyId, index, attempt) => this.dispatcher.takeUp(applyId, index, attempt),
      notice: (n, key) => this.notices.raise(n, key)?.notice_id,
      withdraw: (key) => this.notices.withdraw(key),
      emit: (type, body) => void this.log.append(type, body),
    });
    this.caps = new LoadCaps({
      store: o.store, clock: o.clock, mutant: this.mutant,
      socket: (device) => {
        const d = this.home.devices.get(device);
        return d && this.config.adoptions.get(device)?.class === "socket" ? { open: this.home.feedbackOf(d) === "open" } : undefined;
      },
      reportedOn: (device) => this.home.reportedValue(device, "on"),
      maxOn: (device) => loadIn(this.config, device) === "heating" ? this.config.declarations.get(device)?.max_on_s ?? DEFAULT_MAX_ON_S : undefined,
      turnOff: (device) => {
        const t = this.home.target(device, "onoff.turn_off");
        const g = this.home.gateDevice(device)?.actions.get("onoff.turn_off");
        return t && g && { toggles: g.toggles === true, idempotent: t.idempotent, ack_within_s: t.ack_within_s };
      },
      liveness: (device) => this.home.gateDevice(device)?.liveness,
      capOff: (device, since, attempt) => this.dispatcher.capOff(device, since, attempt),
      notice: (n, key) => this.notices.raise(n, key)?.notice_id,
      withdraw: (key) => this.notices.withdraw(key),
      clear: (key) => this.notices.clear(key),
    });
    this.witnesses = new Witnesses({
      clock: o.clock,
      store: o.store,
      mutant: this.mutant,
      // A witness a declaration change disabled judges nothing (GA-SAFE-14).
      witness: (device, action) => {
        const w = this.config.declarations.get(device)?.witnesses?.[action];
        return w?.disabled === undefined ? w : undefined;
      },
      all: () => [...this.config.declarations].flatMap(([device, d]) => Object.entries(d.witnesses ?? {})
        .filter(([, witness]) => witness.disabled === undefined).map(([action, witness]) => ({ device, action, witness }))),
      key: (w) => w.key ?? this.home.devices.get(w.sensor)?.doc.sensor_keys[0],
      reported: (device, key) => this.home.reportedValue(device, key),
      liveness: (device) => this.home.gateDevice(device)?.liveness,
      bound: (device) => this.home.boundOf(device),
      emit: (type, body) => void this.log.append(type, body),
      witnessed: (applyId, stepId, w) => this.dispatcher.witnessed(applyId, stepId, w),
      judged: (applyId, stepId) => this.dispatcher.heldApply(applyId)?.outcomes.some((x) => x.step_id === stepId && x.witness !== undefined) === true,
      notice: (n, key) => this.notices.raise(n, key)?.notice_id,
      withdraw: (key) => this.notices.withdraw(key),
    });
  }

  /** Reads what the store keeps into every module, and does nothing else: nothing judged, said or armed. Once, on a new applier. */
  async load(): Promise<void> {
    if (this.phase !== "new") throw new Error(`applier bug: load once ${this.phase}`);
    this.phase = "loading";
    // The install's namespace for derived command ids (the maintainer's ruling 2): committed before anything is dispatched.
    let ns = await getMeta(this.o.store, COMMAND_NAMESPACE);
    if (ns === undefined) {
      const fresh = randomUUID();
      await this.o.store.write((tx) => setMeta(tx, COMMAND_NAMESPACE, fresh));
      ns = fresh;
    }
    this.commandNamespace = ns;
    this.config = { ...await loadConfig(this.o.store, { forgetsIgnores: this.mutant.forgetsAnIgnore }), safe: this.levels.includes("Safe") };
    // `forgets-a-tool-hash`: the declarations each tier was set on are not kept across a restart (GA-PERSIST-1).
    if (this.mutant.forgetsAToolHash) for (const d of this.config.declarations.values()) delete d.tier_basis;
    // The owner's credential rotated to one a stored client holds: that client would be taken for the owner.
    const owner = hashSecret(this.o.ownerCredential);
    const holder = [...this.config.clients.values()].find((c) => sameSecret(c.credential_sha256, owner));
    if (holder) throw new Error(`the owner's credential is the one client ${holder.id} holds: set another, or remove the client first`);
    // `forgets-a-retired-identifier`: the identifiers a replacement retired are not read back.
    if (this.mutant.forgetsARetiredIdentifier) this.config.previous = new Map();
    const devices = await this.o.store.query<{ id: string; bridge: string; bridge_device: string; doc: HeldDevice["doc"];
      folded_into: string | null }>("SELECT id, bridge, bridge_device, doc, folded_into FROM devices ORDER BY id");
    const transports = await this.o.store.query<HeldTransport>(
      "SELECT id, bridge, bridge_transport, kind FROM transports ORDER BY id");
    this.home.load(devices.rows.map(({ folded_into, ...d }) => (folded_into === null ? d : { ...d, into: folded_into })), transports.rows);
    // `forgets-connections`: a dead bridge's connections are not read back, so its devices' candidates show.
    if (!this.mutant.forgetsConnections) {
      const conns = await this.o.store.query<{ bridge: string; kind: string; entity: string; keys: string[] }>(
        "SELECT bridge, kind, entity, keys FROM connections ORDER BY bridge, kind, entity");
      this.home.loadConnections(conns.rows);
    }
    // `forgets-announced-names`: the undescribed names announced before the restart are not read back.
    if (!this.mutant.forgetsAnnouncedNames) {
      const names = await this.o.store.query<{ bridge: string; bridge_device: string; name: string }>(
        "SELECT bridge, bridge_device, name FROM undescribed_announced ORDER BY bridge, bridge_device, name");
      this.home.loadAnnounced(names.rows);
    }
    this.home.setOwner(this.config);
    await this.notices.load();
    await this.log.load();
    await this.dispatcher.load();
    await this.provisioner.load();
    await this.safety.load(this.config.rules, this.config.disabled);
    await this.caps.load();
    await this.witnesses.load();
    this.keptRevision = Number((await getMeta(this.o.store, "revision")) ?? "0");
    this.otherAdminsSaid = (await getMeta(this.o.store, OTHER_ADMINS_SAID)) !== undefined;
    this.phase = "loaded";
  }

  /** Every module holds its rows: each judges what is due, in the order they loaded; then the applier's own start. */
  async resume(): Promise<void> {
    // Once, after `load`: a second resume would move `revision` back to what `load` read, and judge again.
    if (this.phase !== "loaded") throw new Error(`applier bug: resume once ${this.phase}`);
    this.phase = "resumed";
    // A revision the last life served and never wrote may be served again for another model after an
    // unclean stop; move past it as the log moves `seq` (the controller's ruling on the spike's finding).
    this.rev = this.keptRevision + (this.log.lastStopClean ? 0 : SEQ_LIFE_GAP);
    // Kept at once, as the log keeps `last_seq`: a second unclean stop then moves past this jump too.
    if (!this.log.lastStopClean) {
      const jumped = this.rev;
      await this.o.store.write((tx) => raiseMeta(tx, "revision", jumped));
    }
    this.dispatcher.resume();
    this.safety.resume();
    this.caps.resume();
    this.provisioner.resume();
    this.witnesses.resume();
    // What each witness's sensor's bound says is seeded without a notice: a restart is no change of the owner's.
    this.witnesses.bounds(true);
    this.brokerCheck(true);
    // A disable written behind a declaration change may be lost to a crash, the devices written and the rule not;
    // the retained document then equals the stored one, so every rule is checked once here (GA-SAFE-13).
    this.disableRules([...new Set([...this.config.rules.values()].flatMap((r) => devicesOf(r)))]);
    this.disableWitnesses(this.witnessSensors());
    // GA-ADOPT-3's once: this build started saying a second door in slice 3; the devices adopted before
    // are told of when a start first finds the flag unset.
    if (!this.otherAdminsSaid) {
      this.home.adopted([...this.config.adoptions.keys()], undefined, true);
      await this.o.store.write((tx) => setMeta(tx, OTHER_ADMINS_SAID, "1"));
      this.otherAdminsSaid = true;
    }
  }

  /** Loads what the store keeps, resumes it, then follows the bridges; the applier serves nothing before it has. */
  async start(): Promise<void> {
    await this.load();
    await this.resume();
    if (this.config.timeSource && this.o.retarget && this.o.runId) await this.o.retarget(this.config.timeSource);
    this.home.follow(this.config.bridges);
    this.o.bus?.follow(this.config.bridges);
    this.schedulePrune();
    this.scheduleTick();
  }

  /** Clears every timer the applier and its modules own, so an embedding host can stop it and then close its store. */
  stop(): void {
    if (this.pruneTimer !== undefined) this.o.clock.clear(this.pruneTimer);
    if (this.tickTimer !== undefined) this.o.clock.clear(this.tickTimer);
    this.dispatcher.stop();
    this.provisioner.stop();
    this.safety.stop();
    this.caps.stop();
    this.witnesses.stop();
    this.log.stop();
  }

  /** The broker is up, and every subscription of `bridge` was granted (the bus's word). */
  listening(bridge: string): void {
    this.home.listening(bridge);
    this.dispatcher.listening();
  }

  /** The broker is lost: every bridged device reads dead (GA-BUS-7); a step in flight waits for its bound (GA-BUS-9). */
  lost(): void {
    // The provisioner first, while the model still knows which bridges were alive.
    this.provisioner.lost();
    this.home.lost();
    this.finder.lost();
  }

  /** Resolved on every request, from the configuration as it is now (GA-AUTH-3). */
  caller(bearer: string | undefined): Caller {
    if (!bearer) return { kind: "anonymous" };
    // A client's credential is held only as its SHA-256: the bearer's is compared, in constant time.
    const hash = hashSecret(bearer);
    if (sameSecret(bearer, this.o.ownerCredential)) {
      // No client is ever taken for the owner: a bearer both hold is no one's (`load` and `configure` refuse it).
      return [...this.config.clients.values()].some((c) => sameSecret(c.credential_sha256, hash)) ? { kind: "anonymous" } : { kind: "owner" };
    }
    for (const c of this.config.clients.values()) {
      if (sameSecret(c.credential_sha256, hash)) {
        if (this.mutant.sessionOutlivesRevocation) this.remembered.set(bearer, c.id);
        return { kind: "client", id: c.id };
      }
    }
    const kept = this.remembered.get(bearer);
    return kept ? { kind: "client", id: kept } : { kind: "anonymous" };
  }

  /**
   * Resolves to a `ToolResult` for a result or a request error. Rejects with `StoreUnavailable`, or
   * the store's own error, when the store cannot keep or give what the call needs; the MCP layer
   * answers that with an internal error.
   */
  async call(caller: Caller, tool: string, args: unknown): Promise<ToolResult> {
    try {
      // `provisions-for-anyone`: a client may call provision; `shows-candidates-to-a-client`, candidates.
      const anyone = caller.kind === "client" && ((tool === "provision" && this.mutant.provisionsForAnyone)
        || (tool === "candidates" && this.mutant.showsCandidatesToAClient));
      const allowed = anyone || (caller.kind === "owner" ? OWNER_TOOLS.has(tool) : caller.kind === "client" && CLIENT_TOOLS.has(tool));
      if (!allowed) throw new RequestError("not_permitted", `not permitted to call ${tool}`);
      const errors = validate(`applier/${tool}.request.json`, args);
      if (errors.length) throw new RequestError("invalid_request", errors.join("; "));
      return { ok: true, body: await this.operation(tool, args as Args, caller) };
    } catch (err) {
      if (err instanceof RequestError) return { ok: false, error: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) };
      throw err;
    }
  }

  private async operation(tool: string, a: Args, caller: Caller): Promise<Record<string, unknown>> {
    switch (tool) {
      case "describe": return this.describe(a);
      case "state": return this.state(a);
      case "plan": return this.plan(a, caller);
      case "apply": return this.apply(a, caller);
      case "outcome": return this.outcome(a, caller);
      case "events": return this.events(a, caller);
      case "history": return this.history(a);
      case "configure": return this.configure(a);
      case "provision": return this.provisioner.provision(a);
      case "candidates": return this.candidates();
      default: throw new RequestError("invalid_request", `unknown operation ${tool}`);
    }
  }

  /** What the finder last said, and the candidates it listed (applier, *Discovery*, GA-DISC-2, GA-DISC-5). */
  private candidates(): Record<string, unknown> {
    const v = this.finder.view();
    return { finder: v.finder, finder_sources: this.mutant.hidesTheFindersSources ? [] : v.sources,
      finder_faults: v.faults, candidates: this.listed(), ignored_keys: [...this.config.ignored_keys].sort() };
  }

  /**
   * The candidates listed now (GA-DISC-2): the one place `candidates`, `ignore_candidate` and
   * `connect` read. A connection of any registered bridge, live or dead, hides a candidate.
   */
  listed(): Listed[] {
    const conns = this.home.connections();
    const bridges = [...this.config.bridges.keys()].map((id) => {
      const f = this.home.bridgeFacts(id);
      return { id, alive: f?.alive ?? false, levels: f?.levels ?? [], ...(f?.bridge_type !== undefined ? { bridge_type: f.bridge_type } : {}) };
    });
    // `lists-a-held-candidate`: only live bridges' connections hide a candidate.
    const holders = this.mutant.listsAHeldCandidate ? bridges.filter((b) => b.alive) : bridges;
    const held = new Set(holders.flatMap((b) => (conns.get(b.id) ?? []).flatMap((c) => c.keys)));
    return Discovery.list(this.finder.view(), held, this.config.ignored_keys, bridges);
  }

  private describe(a: Args): Record<string, unknown> {
    const revision = this.rev;
    if (a.since_revision === revision) return { revision, unchanged: true };
    return {
      applier_id: this.o.applierId, standard_version: STANDARD_VERSION, levels: this.claims(), revision,
      descendants: [], ungoverned: this.home.ungoverned(), box: this.config.box, clients: [...this.config.clients.keys()].sort(),
      devices: this.home.exposed().map((d) => this.home.describeDevice(d)),
      transports: this.home.transports(), safety_rules: this.safety.list(), children: [], ...(this.o.runId ? { test_run_id: this.o.runId } : {}),
    };
  }

  /** The levels claimed now (GA-DESC-6): Safe only with the owner's `box`, and while no bridge declares an `ungoverned` path. */
  claims(): Level[] {
    return claimsOf(this.config, { levels: this.levels, ungoverned: this.home.ungoverned().length > 0 });
  }

  private state(a: Args): Record<string, unknown> {
    const wanted: string[] | undefined = a.targets;
    const targets: Record<string, unknown> = {};
    for (const d of this.home.exposed()) {
      if (!wanted || wanted.includes(d.id)) {
        // An open device's state is the applier's own, assumed from what it last sent (GA-STATE-4).
        const s = this.home.stateOf(d) as { values: unknown[] };
        targets[d.id] = { ...s, values: [...s.values, ...this.dispatcher.assumedState(d.id)] };
      }
    }
    return { targets, transports: this.home.transports(), latches: this.safety.latches.list() };
  }

  /**
   * The gate as it stands now for `client` (applier, *Reason order*): the model's devices, the
   * client's token key, the clock. No token is used before slice 4b dispatches one.
   */
  private gate(client: string): Gate {
    const device = (id: string) => {
      const d = this.home.gateDevice(id);
      // `plans-on-a-candidate`: a step naming a listed candidate's id is planned as if it were a device.
      if (!d && this.mutant.plansOnACandidate && Discovery.listed(this.listed(), id)) return asDevice();
      const l = this.safety.latches;
      return d && { ...d, guarded: this.safety.guarded(id), latched: (action: string, args: Record<string, unknown>) => l.latched(id, action, args),
        raised: (action: string, args: Record<string, unknown>) => l.raises(id, action, args) };
    };
    return { device, client, key: this.config.clients.get(client)?.token_key,
      now: this.o.clock.now(), used: (issuer, tokenId) => this.dispatcher.isUsed(issuer, tokenId), mutant: this.mutant };
  }

  /**
   * `plan` (applier, *Plans*): one step per distinct action, each with the first reason of the
   * standard's order. It changes nothing: no state, no event, no write (GA-PLAN-1); the plan is
   * held in memory for its apply, and expires 60 s after it is made.
   */
  private plan(a: Args, caller: Caller): Record<string, unknown> {
    // Only a client may plan (the owner makes no plan: `OWNER_TOOLS`).
    const client = (caller as { id: string }).id;
    const now = this.o.clock.now();
    this.prunePlans();
    // A map keeps insertion order: the client's first plan held is its oldest.
    const held = [...this.plans].filter(([, p]) => p.plan.client === client);
    for (const [id] of held.slice(0, Math.max(0, held.length - MAX_PLANS_PER_CLIENT + 1))) this.plans.delete(id);
    const plan: ApplierPlan = { plan_id: randomUUID(), expires_at: new Date(now + PLAN_EXPIRY_MS).toISOString(), revision: this.rev,
      client, request: a as ApplierPlan["request"], steps: planSteps(a.actions as Requested[], this.gate(client)) };
    this.plans.set(plan.plan_id, { plan, expiresMs: now + PLAN_EXPIRY_MS });
    if (this.mutant.plansWithSideEffect) this.log.append("model", { revision: this.rev });
    return plan as unknown as Record<string, unknown>;
  }

  /**
   * `apply` (applier, *Apply*). Its idempotency key first: the same key and body from this client in
   * the last 3600 s returns that apply as it stands, and another body is `idempotency_conflict`, nothing
   * dispatched either way (GA-APPLY-4, GA-APPLY-10); a repeat that comes while the first runs waits for
   * it. Then a plan this client made, still unexpired and of the current revision, or a request planned
   * now; anything else is a request error, and nothing is dispatched (GA-APPLY-2).
   */
  private async apply(a: Args, caller: Caller): Promise<Record<string, unknown>> {
    const client = (caller as { id: string }).id;
    // Its actions are kept in the store with its outcomes: a string Postgres cannot keep would stop the writer.
    if (!storable(a)) throw new RequestError("invalid_request", "the request holds a string with U+0000 or a lone surrogate");
    const body = idempotencyBody(a);
    for (;;) {
      const c = this.dispatcher.claim(client, a.idempotency_key, body);
      if (c.kind === "held") return this.dispatcher.outcome(client, c.apply_id)!;
      if (c.kind === "wait") {
        await c.done;
        continue;
      }
      try {
        return await this.applyNew(a, client, c.claim);
      } finally {
        this.dispatcher.release(c.claim);
      }
    }
  }

  /** An apply under a key it has just claimed: no `await` before the dispatcher holds it. */
  private applyNew(a: Args, client: string, claim: Claim): Promise<{ apply_id: string; outcomes: unknown[] }> {
    let steps: Step[];
    let requested: Requested[];
    const inline = a.plan_id === undefined;
    if (!inline) {
      const held = this.plans.get(a.plan_id);
      if (!held) throw new RequestError("unknown_plan", `no plan ${a.plan_id} is held`);
      if (held.plan.client !== client) throw new RequestError("plan_not_yours", `plan ${a.plan_id} was made by another client`);
      if (this.o.clock.now() >= held.expiresMs) throw new RequestError("plan_expired", `plan ${a.plan_id} expired at ${held.plan.expires_at}`);
      if (held.plan.revision !== this.rev) {
        throw new RequestError("stale_revision", `plan ${a.plan_id} was made at revision ${held.plan.revision}, current ${this.rev}`);
      }
      steps = held.plan.steps;
      requested = distinct(held.plan.request.actions as Requested[]);
    } else {
      requested = distinct(a.request.actions as Requested[]);
      steps = planSteps(requested, this.gate(client));
    }
    return this.dispatcher.apply(client, steps, requested, inline, claim);
  }

  /** `outcome`: an apply's outcomes as they are now, to the client that made it; `unknown_apply` otherwise. */
  private outcome(a: Args, caller: Caller): Record<string, unknown> {
    const held = this.dispatcher.outcome((caller as { id: string }).id, a.apply_id);
    if (!held) throw new RequestError("unknown_apply", `no apply ${a.apply_id} of this client is held`);
    return held;
  }

  /**
   * A model change: the revision moves, in memory at once, with its `model` events, and is written
   * behind; never lowered, so write sets that land out of order keep the highest (GA-DESC-2).
   */
  private bumpRevision(bodies: Record<string, unknown>[]): number {
    const revision = ++this.rev;
    for (const body of bodies) this.log.append("model", { revision, ...body });
    this.revision.schedule();
    return revision;
  }

  /**
   * Devices appeared or changed in a bridge's `devices`, or transports in its `status`: a model
   * change, written behind (the storage design).
   */
  private modelChanged(devices: HeldDevice[], transports: HeldTransport[]): void {
    // Derived again from the bridges' retained documents after a restart: dropped past the backlog's cap.
    void this.o.store.write(async (tx) => {
      await saveDevices(tx, devices);
      await saveTransports(tx, transports);
    }, { droppable: true });
    // A copy folded into a device changes that device: its event names the device the model exposes (GA-BUS-11).
    const named = [...new Set(devices.map((d) => d.into ?? d.id))];
    this.dropFallenTiers(named);
    this.bumpRevision([...named.map((device) => ({ device })), ...transports.map((t) => ({ transport: t.id }))]);
  }

  /**
   * An extension tier the owner lowered on declarations of `ids` that have changed is dropped, so it
   * stays fallen back, the declaration's return included, until the owner sets it again (GA-DESC-18,
   * GA-DESC-11). Memory first, at once; the configuration is then written in the owners' line, as it
   * stands when the write runs, so an owner change committed in between keeps the drop (`configure`
   * runs this again after each commit) and the write is safe to run twice.
   */
  private dropFallenTiers(ids: Iterable<string>): void {
    const fallen = [...ids].map((id) => ({ id, actions: fallenTiers(this.config, id, (action) => this.home.fingerprint(id, action), (action) => this.home.requestedTier(id, action),
      { seen: this.home.seen, mutant: this.mutant }) }))
      .filter((x) => x.actions.length > 0);
    if (!fallen.length) return;
    const draft = copyConfig(this.config);
    for (const x of fallen) dropTiers(draft, x.id, x.actions);
    this.commitDerived(draft, "a fallen-back tier's drop");
    this.home.setOwner(draft);
  }

  /**
   * A configuration the applier derived itself (a tier fallen back, a rule or a witness disabled): in
   * memory at once, then written in the owners' line, as the configuration stands when the write runs,
   * so an owner's change committed in between keeps it, and the write is safe to run twice.
   */
  private commitDerived(draft: Config, what: string): void {
    this.config = draft;
    void this.owners.run(() => this.o.store.write((tx) => saveConfig(tx, this.config)))
      .catch((err: unknown) => this.say(`applier: ${what} is not written yet: ${String(err)}`));
  }

  /**
   * The broker's hosts judged again (GA-SAFE-6): a computer that newly counts, its `applier_host`
   * cleared or its `infrastructure` set, or an administrator added to one that counts, is an
   * `other_admin` notice for each safety rule that actuates a device without `accepts_other_admins`:
   * the rule keeps running, since it still closes the valve, but its latch no longer binds that admin.
   * `silent` seeds what is seen without a notice (a start). `set` is a configuration change just
   * committed: the rules it set were checked against the administrators seen when it was planned, so
   * one that came while it waited for its commit is said of them too (as 6b's start re-check). Held in
   * memory only: a restart seeds it again.
   */
  private brokerCheck(silent = false, set?: { rules: SafetyRule[]; planned: ReadonlyMap<string, DeviceInfo> }): void {
    const labels = (infos: ReadonlyMap<string, DeviceInfo>) => new Map(brokerAdmins(this.config, infos, this.mutant)
      .map((b) => [b.computer, new Set(b.admins === "unknown" ? ["unknown"] : b.admins.map((x) => x.label))]));
    const now = labels(this.home.infos());
    const freshOver = (seen: ReadonlyMap<string, Set<string>>) => [...now].flatMap(([computer, ls]) => {
      const fresh = [...ls].filter((l) => !seen.get(computer)?.has(l));
      return fresh.length ? [{ computer, fresh }] : [];
    });
    const added = silent ? [] : freshOver(this.brokerSeen);
    const planned = set && labels(set.planned);
    this.brokerSeen = now;
    for (const r of this.config.rules.values()) {
      if (r.accepts_other_admins === true || !actuated(r).length) continue;
      const mine = planned && set.rules.some((x) => x.id === r.id) ? freshOver(planned) : [];
      const fresh = [...added];
      for (const m of mine) {
        const at = fresh.find((x) => x.computer === m.computer);
        if (!at) fresh.push(m);
        else at.fresh = [...new Set([...at.fresh, ...m.fresh])];
      }
      for (const { computer, fresh: f } of fresh) {
        this.notices.raise({ cause: "other_admin", rule_id: r.id, devices: [computer, ...actuated(r)],
          text: `${computer} carries the broker, and has ${f.map((l) => l === "unknown" ? "administrators not known" : JSON.stringify(l)).join(", ")} `
            + `as administrator, who reach${f.length > 1 ? "" : "es"} every device the applier governs. Safety rule ${r.id} still runs, `
            + `but its latch no longer binds ${f.length > 1 ? "them" : "that administrator"}: they can undo what it does.` });
      }
    }
  }

  /**
   * Devices whose declarations changed (applier, *The applier's own actuations*): each safety rule
   * naming one that no longer fits them (`declarationFault`: a key or action gone, args the device
   * refuses, an action declared `toggles: true`) is disabled, with a `rule_disabled` notice saying why,
   * and fires no more until the owner sets it again (GA-SAFE-13). A model change: memory at once, the
   * configuration written in the owners' line, as `dropFallenTiers` writes it.
   */
  private disableRules(ids: string[]): void {
    const infos = this.home.infos();
    // `keeps-a-rule-on-a-re-taught-code` keeps a rule whose action is now a toggle, and only that: a key
    // taken away still disables it (GA-SAFE-14), so the mutation breaks its own row alone.
    const toggles = this.mutant.togglesBySafetyRule || this.mutant.keepsARuleOnAReTaughtCode;
    const hit = [...this.config.rules.values()].filter((r) => !this.config.disabled.has(r.id) && devicesOf(r).some((d) => ids.includes(d)))
      .map((r) => ({ r, fault: declarationFault(r, infos, { toggles }) })).filter((x): x is { r: typeof x.r; fault: string } => x.fault !== undefined);
    if (!hit.length) return;
    const draft = copyConfig(this.config);
    for (const x of hit) draft.disabled.set(x.r.id, x.fault);
    this.commitDerived(draft, "a disabled safety rule");
    this.safety.setRules(draft.rules, draft.disabled);
    for (const x of hit) {
      this.notices.raise({ cause: "rule_disabled", rule_id: x.r.id, devices: devicesOf(x.r).filter((d) => ids.includes(d)),
        text: `Safety rule ${x.r.id} is disabled: its devices' declarations changed, and ${x.fault}. It does nothing until you set it again.` },
      disabledKey(x.r.id));
    }
    this.bumpRevision(hit.map((x) => ({ safety_rule: x.r.id, disabled: true })));
  }

  /** The sensors every witness reads. */
  private witnessSensors(): string[] {
    return [...new Set([...this.config.declarations.values()].flatMap((d) => Object.values(d.witnesses ?? {}).map((w) => w.sensor)))];
  }

  /**
   * Sensors whose declarations changed (GA-SAFE-14): each witness reading a key its sensor no longer
   * declares is disabled, with a `rule_disabled` notice naming the key, and judges nothing until the
   * owner sets it again, which checks it as new. A witness keeps the key it reads from its configure on
   * (the sensor's first, where the owner named none), so a restart judges it against the same key. A
   * model change, written in the owners' line, as `disableRules` writes a rule's.
   */
  private disableWitnesses(ids: string[]): void {
    const hit: { device: string; action: string; sensor: string; why: string }[] = [];
    for (const [device, d] of this.config.declarations) {
      for (const [action, w] of Object.entries(d.witnesses ?? {})) {
        if (w.disabled !== undefined || !ids.includes(w.sensor)) continue;
        const keys = this.home.devices.get(w.sensor)?.doc.sensor_keys;
        if (!keys) continue;
        if (w.key === undefined) {
          if (keys[0] === undefined) hit.push({ device, action, sensor: w.sensor, why: `${w.sensor} declares no sensor key now` });
          continue;
        }
        if (keys.includes(w.key)) continue;
        hit.push({ device, action, sensor: w.sensor, why: `${w.sensor} declares no sensor key ${w.key} now` });
      }
    }
    if (!hit.length) return;
    const draft = copyConfig(this.config);
    for (const x of hit) draft.declarations.get(x.device)!.witnesses![x.action]!.disabled = x.why;
    this.commitDerived(draft, "a disabled witness");
    this.home.setOwner(draft);
    for (const x of hit) {
      this.notices.raise({ cause: "rule_disabled", witness: { device: x.device, action: x.action }, devices: [x.sensor, x.device],
        text: `The witness on ${x.device}'s ${x.action} is disabled: its sensor's declarations changed, and ${x.why}. `
          + "It judges nothing until you set it again." }, `rule_disabled:witness:${x.device}:${x.action}`);
    }
    this.bumpRevision(hit.map((x) => ({ device: x.device, witness: x.action, disabled: true })));
  }

  /** Transports left the model: a model change, written behind, and derived again after a restart if its write is dropped. */
  private transportsGone(transports: HeldTransport[]): void {
    void this.o.store.write((tx) => forgetTransports(tx, transports.map((t) => t.id)), { droppable: true });
    this.bumpRevision(transports.map((t) => ({ transport: t.id, removed: true })));
  }

  /**
   * The owner's change reaches memory only once it has committed, and the next waits in line until
   * then (the storage design, *The applier, safety first*). A caller whose change has not committed
   * within 10 s gets `StoreUnavailable`: the change stays queued and takes effect when the store
   * returns. A change that waited out its 10 s in line, behind another, is never applied.
   */
  private configure(a: Args): Promise<Record<string, unknown>> {
    // Its values are kept in the store: a string Postgres cannot keep would stop the writer, as for `apply`.
    if (!storable(a)) return Promise.reject(new RequestError("invalid_request", "the change holds a string with U+0000 or a lone surrogate"));
    const arrived = this.o.clock.now();
    const change = this.owners.run(async () => {
      if (this.o.clock.now() - arrived >= GATE_MS) throw new StoreUnavailable("an earlier owner change is still waiting for the store");
      const revision = this.rev;
      const changes = a.changes as Change[];
      // GA-CFG-2: a set of nothing but ignores needs no expected_revision and is never stale (applier, *Discovery*).
      const ignoresOnly = changes.length > 0 && changes.every((c) => IGNORE_KINDS.has(c.kind)) && !this.mutant.checksRevisionForIgnores;
      if (!ignoresOnly) {
        if (a.expected_revision === undefined) throw new RequestError("invalid_request", "expected_revision is required unless the set holds only ignores");
        if (a.expected_revision !== revision) throw new RequestError("stale_revision", `expected_revision ${a.expected_revision}, current ${revision}`);
      }
      const planned = this.home.infos();
      const { draft, diff, forgotten, replaced, routed, unrouted, cleared } = planChanges(this.config, a.changes as Change[],
        { levels: this.levels, underHarness: !!this.o.runId, ownerCredential: this.o.ownerCredential, ownIdentity: this.o.applierId,
          devices: planned, mutant: this.mutant, ungoverned: this.home.ungoverned().length > 0,
          plainOffLoopback: this.o.plainOffLoopback, latches: new Set(this.safety.latches.list().map((l) => l.rule_id)),
          listed: () => this.listed() });
      if (a.dry_run) return { diff: diff.length ? diff.join("\n") : "no change" };
      if (draft.timeSource && draft.timeSource !== this.config.timeSource) {
        if (!this.o.retarget) throw new RequestError("invalid_request", "this applier cannot take a time_source");
        await this.o.retarget(draft.timeSource).catch((err: unknown) => {
          throw new RequestError("invalid_request", `time_source ${draft.timeSource}: ${String(err)}`);
        });
      }
      // A route's rows, as the model holds its copies after any await above (GA-BUS-11); memory places
      // exactly these once they commit.
      const placed = routed.flatMap((r) => this.home.routeRows(r));
      const changed = modelKey(draft) !== modelKey(this.config) || forgotten.length > 0 || replaced.length > 0 || placed.length > 0
        || cleared.length > 0;
      // The id map moves with the configuration: each replaced id's row now names its new hardware, as
      // the model holds it after any await above. Only the owner's own changes take a device out of the
      // model, and they wait in line behind this one, so a device missing here is a bug, refused.
      const moves = replaced.map((r) => {
        const held = this.home.devices.get(r.device);
        if (!held) throw new RequestError("invalid_request", `${r.device} left the model while this change was planned`);
        return { from: r.device, to: { ...held, id: r.replaces } };
      });
      // A new rule's seen bases, as the model holds its reports now: committed with the rule (GA-SAFE-11).
      const seeds = this.safety.seedRows(draft.rules);
      await this.o.store.write(async (tx) => {
        await saveConfig(tx, draft, this.o.clock.now());
        // A crash right after cannot fire the rule on a report held before it.
        for (const r of seeds) await saveSeen(tx, r.device, r.key, r.basis);
        await forgetDevices(tx, forgotten);
        await forgetAssumed(tx, forgotten);
        await repointDevices(tx, moves);
        await placeDevices(tx, placed);
        // A latch the owner cleared stays cleared once the change committed (GA-PERSIST-1).
        if (cleared.length) await tx.query("DELETE FROM safety_latches WHERE rule_id = ANY($1)", [cleared]);
      });
      // Committed: the change reaches memory, and its model events are served and written behind.
      const before = this.config;
      this.config = draft;
      const kept = this.home.setOwner(draft, { forgotten, replaced, routed }, placed);
      // A tier this change planned on an older configuration, set on declarations changed since, falls back again.
      this.dropFallenTiers(draft.declarations.keys());
      this.dispatcher.forget(forgotten);
      this.safety.setRules(draft.rules, draft.disabled);
      for (const id of cleared) this.safety.clearLatch(id);
      // A socket adopted on, new hardware already on under a kept id, a load no longer heating, a lower cap (GA-LOAD-2).
      const adopted = [...draft.adoptions.keys()].filter((id) => !before.adoptions.has(id));
      this.caps.seen([...adopted, ...replaced.map((r) => r.replaces)]);
      this.caps.configured();
      // A socket taken as heating whose turn-off is a toggle: at its adoption, its cap cannot act (GA-SAFE-13).
      this.caps.judge([...draft.adoptions.keys()], [...adopted, ...replaced.map((r) => r.replaces)]);
      // A witness configured over a sensor whose fresh_s is not known, or the owner's longer than declared (GA-WIT-1).
      this.witnesses.bounds();
      // An applier_host cleared, an infrastructure set: the broker's host has admins it did not have; or it came while
      // this change waited for its commit, after its rules were checked (GA-SAFE-6).
      this.brokerCheck(false, { planned, rules: [...draft.rules.values()].filter((r) => JSON.stringify(before.rules.get(r.id)) !== JSON.stringify(r)) });
      // A disabled rule the owner set again, or deleted, is said no more; one a declaration change disabled while
      // this change waited for its commit is disabled again (its notice raised once while its key stands).
      const infos = this.home.infos();
      for (const id of before.disabled.keys()) {
        const r = draft.rules.get(id);
        if (!r || (!draft.disabled.has(id) && declarationFault(r, infos) === undefined)) this.notices.clear(disabledKey(id));
      }
      this.disableRules([...new Set([...draft.rules.values()].flatMap((r) => devicesOf(r)))]);
      // A witness the owner set again, or deleted, no longer stands disabled: its notice goes (GA-SAFE-14).
      for (const [device, d] of before.declarations) {
        for (const [action, w] of Object.entries(d.witnesses ?? {})) {
          if (w.disabled !== undefined && draft.declarations.get(device)?.witnesses?.[action]?.disabled === undefined) {
            this.notices.clear(`rule_disabled:witness:${device}:${action}`);
          }
        }
      }
      // A witness this change waited on may have lost its sensor's key meanwhile (GA-SAFE-14).
      this.disableWitnesses(this.witnessSensors());
      // A safety rule actuating a device on a transport that can answer nothing: an open_loop notice naming it (GA-ADOPT-6).
      for (const [id, r] of draft.rules) {
        if (JSON.stringify(before.rules.get(id)) === JSON.stringify(r)) continue;
        for (const device of actuated(r).filter((x) => this.home.onUnknownTransport(x))) {
          this.notices.raise({ cause: "open_loop", rule_id: id, devices: [device], text: `Safety rule ${id} actuates ${device}, `
            + "on a transport that can answer nothing: if it stops working, nothing will show, and the rule's action there ends sent." });
        }
      }
      // A device adopted now, or new hardware under a replaced id, is judged for a second door (GA-ADOPT-3).
      this.home.adopted([...[...draft.adoptions.keys()].filter((id) => !before.adoptions.has(id)), ...replaced.map((r) => r.replaces)], before);
      if (JSON.stringify([...before.bridges]) !== JSON.stringify([...draft.bridges])) {
        this.home.follow(draft.bridges);
        this.o.bus?.follow(draft.bridges);
      }
      // `ignore-moves-the-revision`: a change of the ignores taken as a model change.
      const ignoresMoved = this.mutant.ignoreMovesTheRevision
        && JSON.stringify([...before.ignored_keys].sort()) !== JSON.stringify([...draft.ignored_keys].sort());
      if (!changed && !ignoresMoved) return { revision: this.rev };
      if (!changed) return { revision: this.bumpRevision([]) };
      return { revision: this.bumpRevision([...modelEvents(before, draft, { forgotten, replaced, kept, routed, placed, unrouted }, cleared.length > 0),
        ...cleared.map((rule) => ({ safety_rule: rule, latch: "cleared_by_owner" }))]) };
    });
    return within(this.o.clock, GATE_MS, change);
  }

  /**
   * Served from memory, so it answers while the store is down. A long poll holds nothing. Every
   * notice not yet taken rides on every response; a client's `notice_taken` takes them, the owner's
   * is ignored (applier, *Events and history*).
   */
  private async events(a: Args, caller: Caller): Promise<Record<string, unknown>> {
    if (caller.kind === "client" && a.notice_taken?.length) this.notices.take(a.notice_taken);
    if (a.cursor === undefined) return { events: [], cursor: this.log.cursor(), notices: this.notices.list() };
    const read = () => {
      const events = this.log.read(a.cursor);
      return { events, cursor: events.length ? String(events[events.length - 1]!.seq) : a.cursor, notices: this.notices.list() };
    };
    const first = read();
    if (first.events.length || !a.wait_s) return first;
    await this.log.wait(a.wait_s * 1000);
    return read();
  }

  /** Read from the store, so it fails while the store is down (the storage design). */
  private async history(a: Args): Promise<Record<string, unknown>> {
    if (this.o.store.down) throw new StoreUnavailable("the store is unreachable");
    // An occurrence of a key personal now is hidden too, whatever it was when it happened (GA-EVT-5).
    const hidden = (e: { type: string; target?: unknown; key?: unknown }) => !this.mutant.historyKeepsAPersonalOccurrence
      && e.type === "occurrence" && typeof e.target === "string" && typeof e.key === "string" && this.home.personalNow(e.target, e.key);
    return { events: await within(this.o.clock, GATE_MS, this.log.history(Date.parse(a.from), Date.parse(a.to), a.targets, hidden)) };
  }

  private scheduleTick(): void {
    this.tickTimer = this.o.clock.setTimeout(() => {
      this.home.tick();
      this.caps.tick();
      this.finder.tick();
      this.scheduleTick();
    }, TICK_MS);
  }

  /** Drops each plan long expired (held as long again, for `plan_expired`), and each plan of a client no longer configured. */
  private prunePlans(): void {
    const now = this.o.clock.now();
    for (const [id, p] of this.plans) {
      if (p.expiresMs + PLAN_EXPIRY_MS <= now || !this.config.clients.has(p.plan.client)) this.plans.delete(id);
    }
  }

  private schedulePrune(): void {
    this.pruneTimer = this.o.clock.setTimeout(() => {
      this.prunePlans();
      this.log.prune();
      this.dispatcher.prune();
      this.provisioner.prune();
      this.schedulePrune();
    }, PRUNE_EVERY_MS);
  }
}
