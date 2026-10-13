import { planDefine, type Change, type DefineContext, type DeviceView } from "../src/house/define.js";
import { emptyHouse, withFirstOwner, type House } from "../src/house/model.js";

/**
 * The applier's devices as a test's mirror holds them: an adopted notify channel, a speaker, a lamp, a
 * dimmer, a wake relay's entry (`internal`), and one not adopted.
 */
export const DEVICES: Record<string, DeviceView> = {
  "sim-bridge:channel": { adopted: true, internal: false, actions: ["notify.notify"] },
  "sim-bridge:speaker": { adopted: true, internal: false, actions: ["media.announce", "media.pause"] },
  "sim-bridge:lamp": { adopted: true, internal: false, actions: ["onoff.turn_on", "onoff.turn_off"] },
  "sim-bridge:dimmer": { adopted: true, internal: false, actions: ["onoff.turn_on", "onoff.turn_off", "level.set_level"] },
  "sim-bridge:entry": { adopted: true, internal: true, actions: ["onoff.turn_on", "onoff.turn_off"] },
  "sim-bridge:stray": { adopted: false, internal: false, actions: ["notify.notify"] },
};

export const context = (o: Partial<DefineContext> = {}): DefineContext =>
  ({ device: (id) => DEVICES[id], underHarness: true, ...o });

export const SECRETS = { owner: "owner-secret-0123456789", olga: "olga-secret-0123456789", panel: "panel-secret-0123456789",
  brain: "brain-secret-0123456789", front: "front-secret-0123456789" };

export const up = (kind: string, value: unknown): Change => ({ op: "upsert", kind, value });
export const del = (kind: string, value: unknown): Change => ({ op: "delete", kind, value });

/** The owner's chat window in their app, which the brain serves: work defined there is brain_authored (GA-DEF-7). */
export const OWNER_CHAT = up("endpoint", { id: "owner-chat", name: "Чат владельца", type: "app", room: null, person: "owner", served_by: "brain" });

/** The house the harness's setup defines, as one change set (the first owner already there). */
export const BASELINE: Change[] = [
  up("home", { timezone: "Europe/Moscow", notice_channels: ["sim-bridge:channel"] }),
  up("room", { id: "hall", name: "Холл" }), up("room", { id: "kitchen", name: "Кухня" }),
  up("person", { id: "olga", name: "Ольга", role: "member" }), up("person", { id: "liza", name: "Лиза", role: "guest" }),
  up("endpoint", { id: "olga-app", name: "Телефон Ольги", type: "app", room: null, person: "olga", served_by: null }),
  up("endpoint", { id: "hall-panel", name: "Панель в холле", type: "panel", room: "hall", person: null, served_by: null }),
  up("endpoint", { id: "kitchen-voice", name: "Кухня", type: "voice", room: "kitchen", person: null, served_by: "brain" }),
  up("voice", { endpoint: "kitchen-voice", listening: "wake_server", wake_words: [{ word: "Галатея", model: "transcript" }],
    zone: "downstairs", output: "speech", follow_up: false, heard_by: "front" }),
  up("credential", { id: "olga-app", kind: "app", secret: SECRETS.olga, endpoint: "olga-app" }),
  up("credential", { id: "hall-panel", kind: "panel", secret: SECRETS.panel, endpoint: "hall-panel" }),
  up("credential", { id: "brain", kind: "brain", secret: SECRETS.brain }),
  up("credential", { id: "front", kind: "front", secret: SECRETS.front }),
];

/** A house with the first owner (person, app endpoint and credential), as a fresh start makes it. */
export const withOwner = (): House => withFirstOwner(emptyHouse(), SECRETS.owner);

/** The baseline house: the owner's, plus BASELINE. */
export function baseline(): House {
  return planDefine(withOwner(), BASELINE, context()).draft;
}

/** The lamp and the dimmer named and in the hall, and a group of both. */
export const FURNISHED: Change[] = [
  up("target", { id: "sim-bridge:lamp", name: "Лампа", aliases: ["свет"], room: "hall" }),
  up("target", { id: "sim-bridge:dimmer", room: "hall" }),
  up("group", { id: "hall-lights", name: "Свет в холле", room: "hall", members: ["sim-bridge:lamp", "sim-bridge:dimmer"], aggregate: "any" }),
];

/** The baseline house with FURNISHED. */
export function furnished(): House {
  return planDefine(baseline(), FURNISHED, context()).draft;
}
