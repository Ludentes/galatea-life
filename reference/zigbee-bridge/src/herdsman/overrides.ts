import type { ActionDecl, ArgConstraint } from "../vocabulary.js";

/**
 * The per-model override table (the design, *The override table*): what a converter definition's
 * `exposes` cannot say, as data, keyed by the converters' `model`. Written from the devices'
 * passports; every entry names its source.
 */
export interface Override {
  /** Properties whose values are occurrences, not state: `event` keys (GA-BRIDGE-75). */
  events?: string[];
  /** For an event property, the one value that is an occurrence; any other is none (a status that clears nothing happened). */
  occurrence?: Record<string, string | number | boolean>;
  /** The converters' options for the model, as zigbee2mqtt's device options give them to its converters and hooks. */
  options?: Record<string, unknown>;
  /**
   * Attributes the converters take from no report, by `<cluster>.<attribute>`, each read as the
   * converter property it names, its value as the device reports it.
   */
  attributes?: Record<string, string>;
  /**
   * A property's applier key where the model's reading means other than the mapping layer's default
   * (`SENSORS` in `describe.ts`): a radar whose definition calls its presence `occupancy` maps it to
   * `occupancy`, not `motion` (GA-BRIDGE-78). Recorded in the model's passport.
   */
  meaning?: Record<string, string>;
  /**
   * Sensor keys the model's definition promises that a unit was seen not to send (on the bench, or
   * in the field): held back until the device first reports each, and listed in `awaitedKeys`
   * meanwhile (GA-BRIDGE-80). Only these: every other key is declared from the start, so a reading a
   * safety rule waits for is never held back. Recorded in the model's passport.
   */
  awaited?: string[];
  /**
   * Data the device sends that repeats a reading it already sends by another path, by its undescribed
   * name (a radar's ZCL battery report beside its Tuya datapoint): dropped, never listed as undescribed,
   * its message still a check-in (GA-BRIDGE-76). Which path is the reading is the maker's word,
   * recorded in the model's passport.
   */
  duplicates?: string[];
  /** Properties a converter publishes later from its own timer, not from a device message: dropped (GA-BRIDGE-1, 5). */
  dropLate?: string[];
  /** Properties the converters report that no expose names, declared as extension `state` keys, with their JSON Schemas. */
  keys?: Record<string, { schema: Record<string, unknown>; description: string }>;
  /**
   * A key's JSON Schema, replacing the expose's, where the device reports values its converter does
   * not declare: its readings are taken within it. The set's argument stays the expose's (or `args`').
   */
  schemas?: Record<string, Record<string, unknown>>;
  /** An argument's constraint, replacing the expose's: a value the device takes but the bridge does not offer is left out. */
  args?: Record<string, ArgConstraint>;
  /** Properties whose set is not idempotent whatever their value. */
  notIdempotent?: string[];
  /** The device's reach, measured on the bench, where it has no Poll Control to read it from (GA-BRIDGE-7). */
  reachMs?: number;
  /**
   * False where the bench saw the model answer no poll (`polling.ts`): it is not polled though in
   * reach, and its bound is the reporting's, or null. Recorded in the model's passport.
   */
  poll?: false;
  /**
   * Reports the bridge configures on the device, where its definition's `configure` sets up none
   * (the design, *Freshness*): each a ZCL Configure Reporting on the first endpoint that serves its
   * cluster, sent with the definition's `configure`, after it, in the same run. Once the device has
   * accepted them (its Configure Reporting Response, which herdsman records), its bound is twice the
   * longest maximum interval (GA-BRIDGE-13). Recorded in the model's passport.
   */
  reports?: ReportSetUp[];
  /**
   * The bench saw the model accept a configured report and then not report by it, with the date and
   * what was seen: its bound from configured reporting is null, whatever it accepted (bridge 0.6, *The
   * roster and freshness*: "the bridge's maker records that per model").
   */
  reportsIgnored?: Measured;
  /**
   * The interval the model reports at on its own, where no report is configured, as the bench measured
   * it, with the date and what was seen (GA-BRIDGE-13's "the interval its model is known to report
   * at"): its bound is twice that, allowing one missed report (the design, *Freshness*). Never a figure
   * the bridge sees at run time: only one the maker measured and recorded here.
   */
  rhythm?: Measured & { everyMs: number };
  /**
   * The device's settings (*Declarations and settings*): properties that configure it and change only
   * when written. Each one confirmed is kept across restarts with its time (GA-BRIDGE-79), and the
   * declarations may rest on them (GA-BRIDGE-74, `declare`).
   */
  settings?: string[];
  /**
   * A press, stateless and not idempotent, offered as the extension's `press` and carried as a set of
   * `property` to `value`: for a pusher whose state does not change on a repeated press, where a
   * stateful `onoff` would be `already` (a bridge cannot make `onoff` stateless, *Devices*). A press
   * is a toggle unless the owner says otherwise (the maintainer's rulings, 2026-10-06), until the
   * vocabulary's `button.press`. The model's `declare` says in which settings it is offered.
   */
  press?: { property: string; value: string | number | boolean; description: string };
  /**
   * The actions as they hold for the settings as last observed, by property (`undefined` where a
   * setting was never observed): an action that depends on one never observed is not offered
   * (GA-BRIDGE-74).
   */
  declare?(settings: Record<string, unknown>, actions: ActionDecl[]): ActionDecl[];
}

/** A report the bridge configures (`Override.reports`): herdsman's `configureReporting` item, on the cluster's first endpoint. */
export interface ReportSetUp {
  cluster: string;
  attribute: string;
  /** Seconds. */
  minimumReportInterval: number;
  /** Seconds: the bound is twice the longest of these once accepted. */
  maximumReportInterval: number;
  reportableChange: number;
}

/** A per-model fact measured on the bench: when, and what was seen. */
export interface Measured {
  /** The bench run's date, `YYYY-MM-DD`. */
  measured: string;
  seen: string;
}

/**
 * The battery report the bridge configures on a sleeping sensor whose definition sets up none
 * (the maintainer's ruling of 2026-10-06, lesson 1): genPowerCfg's remaining percentage, every hour,
 * so a device that accepts it checks in at least hourly and its bound is two hours (⚠️ a guess at the
 * interval: an hour, as HS29's radar has it; costs one report an hour of the battery).
 */
export const BATTERY_REPORT: ReportSetUp = { cluster: "genPowerCfg", attribute: "batteryPercentageRemaining", minimumReportInterval: 3_600,
  maximumReportInterval: 3_600, reportableChange: 0 };

const ONOFF = new Set(["onoff.turn_on", "onoff.turn_off"]);

/** The table, by the converters' `model`. */
export const OVERRIDES: Readonly<Record<string, Override>> = {
  /**
   * The radar presence sensor (passport, the bench run of 2026-10-06): its definition promises
   * temperature and humidity, and the bench's unit, firmware as shipped, sent neither in a day, while
   * reporting presence on change and its light every minute. Both are held back until it reports
   * one (GA-BRIDGE-80). Its `presence` maps to `occupancy` by the mapping layer's default. Its ZCL
   * reports of battery and light repeat the Tuya datapoints its definition maps: duplicates, still
   * check-ins (GA-BRIDGE-76).
   */
  "ZG-204ZV": {
    awaited: ["temperature", "humidity"],
    // Its definition's configure sets up no reporting; it serves genPowerCfg, whose reports it already
    // sends (the duplicates below): an hourly battery report, if it accepts one (the design, *Freshness*).
    reports: [BATTERY_REPORT],
    duplicates: ["genPowerCfg.batteryPercentageRemaining", "genPowerCfg.batteryVoltage", "msIlluminanceMeasurement.measuredValue"],
    settings: ["fading_time", "motion_detection_sensitivity", "indicator", "illuminance_interval", "temperature_unit", "temperature_calibration", "humidity_calibration"],
  },
  /**
   * The vibration sensor (passport, bench spike 1): it reports a status change on every movement and
   * never one that clears it, so `vibration` is an occurrence, and only its `true` is one: a status
   * with the alarm bit clear (a tamper change) is no vibration. The converter's own `vibration:
   * false`, from its timer, is no message of the device's: its timer is turned off
   * (`vibration_timeout: 0`), and a late `vibration` is dropped should one come anyway. The zone
   * status's tamper and battery-low bits are reported by the converter, though no expose names them.
   * The device reports its sensitivity as the IAS zone's `currentZoneSensitivityLevel`, the
   * attribute the converter writes it to, value as written; no converter reads that report. Its
   * sensitivity is set within the converter's 0 to 50, and offered only once a reach of 145 s or less
   * is known for it: it has no Poll Control, and listens only for a second or two after an event. The
   * device takes 200 too (set by another controller), so the key reads 0 to 200, never leaving a 200
   * to stand as the last value within 0 to 50 (plan 2c-2 review M3).
   */
  TS0210: {
    events: ["vibration"],
    occurrence: { vibration: true },
    options: { vibration_timeout: 0 },
    dropLate: ["vibration"],
    attributes: { "ssIasZone.currentZoneSensitivityLevel": "sensitivity" },
    // Its definition has no configure, and it checks in only when it moves: an hourly battery report,
    // configured in its awake moment after a message, if it accepts one (the design, *Freshness*).
    reports: [BATTERY_REPORT],
    schemas: { sensitivity: { type: "number", minimum: 0, maximum: 200 } },
    settings: ["sensitivity"],
    keys: {
      tamper: { schema: { type: "boolean" }, description: "The IAS zone status's tamper bit" },
      battery_low: { schema: { type: "boolean" }, description: "The IAS zone status's battery-low bit" },
    },
  },
  /**
   * The button pusher (passport, bench spike 2). `mode` changes what `onoff` is: in click mode a turn
   * on or off is a press every time, not idempotent; in switch mode it holds a position, idempotent;
   * until `mode` has been observed, or in program mode, whose format is unknown, `onoff` is not
   * offered. Program mode is not offered, and setting `mode` moved the arm on the bench, so its set is
   * not idempotent. Its reach is the bench's measured answer time (⚠️ one bench, until its poll
   * interval is measured: it has no Poll Control).
   */
  TS0001_fingerbot: {
    args: { mode: ["click", "switch"] },
    notIdempotent: ["mode"],
    reachMs: 2_500,
    settings: ["mode", "lower", "upper", "delay", "reverse", "touch"],
    // In click mode the arm presses on every `on`, and `on` stays true: a press, not `onoff`.
    press: { property: "state", value: "ON", description: "Presses the button: the arm goes down for its delay, then up" },
    declare: (s, actions) => {
      const press = (a: { action: string }) => a.action.endsWith(".press");
      if (s.mode === "click") return actions.filter((a) => !ONOFF.has(a.action));
      if (s.mode === "switch") return actions.filter((a) => !press(a));
      return actions.filter((a) => !ONOFF.has(a.action) && !press(a));
    },
  },
};

/** The model's override, if any; an inherited property name such as "constructor" is none. */
export function overrideFor(model: string, table: Readonly<Record<string, Override>> = OVERRIDES): Override | undefined {
  return Object.hasOwn(table, model) ? table[model] : undefined;
}
