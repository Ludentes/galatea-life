import type { Urgency } from "./port.js";

/** `notify`'s `from`, in the applier's four shapes (`standard/applier.md`, the capability table). */
export type NotifyFrom =
  | { endpoint: string; role: string }
  | { rule: string; brain_authored?: boolean }
  | { scenario: string; brain_authored?: boolean }
  | { notice: string };

export interface NotifyValue {
  text: string;
  urgency: Urgency;
  from?: NotifyFrom;
}

const URGENCIES: readonly string[] = ["info", "warning", "critical"];

/** Each shape's keys, and which of them may be left out. */
const SHAPES: { keys: string[]; optional: string[] }[] = [
  { keys: ["endpoint", "role"], optional: [] },
  { keys: ["rule", "brain_authored"], optional: ["brain_authored"] },
  { keys: ["scenario", "brain_authored"], optional: ["brain_authored"] },
  { keys: ["notice"], optional: [] },
];

function fromError(from: unknown): string | undefined {
  if (!from || typeof from !== "object" || Array.isArray(from)) return "from is not an object";
  const f = from as Record<string, unknown>;
  const keys = Object.keys(f);
  const shape = SHAPES.find((s) => s.keys.filter((k) => !s.optional.includes(k)).every((k) => keys.includes(k)) && keys.every((k) => s.keys.includes(k)));
  if (!shape) return `from has the keys ${keys.join(", ") || "none"}, none of the applier's shapes`;
  for (const k of keys) {
    if (k === "brain_authored" ? typeof f[k] !== "boolean" : typeof f[k] !== "string" || f[k] === "") return `from.${k} is not ${k === "brain_authored" ? "a boolean" : "a non-empty string"}`;
  }
  return undefined;
}

/**
 * What is wrong with a `notify`'s inner value, or undefined when it fits its declared `args`: an
 * object of `text`, a non-empty string, `urgency`, one of three, and `from` where given, in one of
 * the applier's shapes, and no other key (GA-BRIDGE-4).
 */
export function notifyError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "notify takes an object of text, urgency and from";
  const v = value as Record<string, unknown>;
  const unknown = Object.keys(v).filter((k) => k !== "text" && k !== "urgency" && k !== "from");
  if (unknown.length) return `unknown keys: ${unknown.join(", ")}`;
  if (typeof v.text !== "string" || v.text === "") return "text is not a non-empty string";
  if (typeof v.urgency !== "string" || !URGENCIES.includes(v.urgency)) return `urgency is none of ${URGENCIES.join(", ")}`;
  if (v.from !== undefined) return fromError(v.from);
  return undefined;
}

/** The steward's roles (`standard/steward.md`), as a person reads them. */
const ROLES: Record<string, string> = { owner: "хозяин", member: "домочадец", guest: "гость", visitor: "посетитель" };

/**
 * The wording a person sees, in the house's language (Russian): the source first, then a newline,
 * then the text, so that a guest's text cannot pass for the house's own message, and a `notify`
 * without `from` is marked as from an unknown sender, never unmarked (GA-BRIDGE-56). The wording is
 * the maintainer's to change.
 */
export const WORDING = {
  endpoint: (endpoint: string, role: string) => `От: ${endpoint} (${ROLES[role] ?? role})`,
  rule: (rule: string) => `От: правило «${rule}»`,
  scenario: (scenario: string) => `От: сценарий «${scenario}»`,
  notice: () => "От: Galatea",
  brainAuthored: " — написано ассистентом",
  unknown: "От: неизвестный отправитель",
};

export function shownText(text: string, from: NotifyFrom | undefined): string {
  return `${source(from)}\n${text}`;
}

function source(from: NotifyFrom | undefined): string {
  if (!from) return WORDING.unknown;
  if ("endpoint" in from) return WORDING.endpoint(from.endpoint, from.role);
  if ("notice" in from) return WORDING.notice();
  const brain = from.brain_authored ? WORDING.brainAuthored : "";
  if ("rule" in from) return WORDING.rule(from.rule) + brain;
  return WORDING.scenario(from.scenario) + brain;
}
