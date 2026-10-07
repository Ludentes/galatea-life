import { setLogger } from "zigbee-herdsman";
import { setLogger as setConvertersLogger } from "zigbee-herdsman-converters";

/**
 * herdsman's log and the converters', made safe to keep (the design, *The network guard*, *Secrets*; GA-BRIDGE-24).
 * herdsman logs the network key in several forms: in hex when a configuration and the coordinator
 * disagree, as a decimal list in its Z-Stack frame dumps, and as `{"type":"Buffer","data":[...]}`
 * in its NV traces (bench data, plan 2a). The Z-Stack frame dumps are dropped whole, and every
 * line is redacted before it is written.
 */

/** The namespaces whose debug lines are the coordinator's frames and NV payloads, the key's bytes among them: dropped whole. */
const FRAME_DUMPS = /^zh:zstack:(unpi|znp)/;

/**
 * Removes every run that could carry a key's 16 bytes: a Node Buffer's JSON form, a list of twelve
 * or more decimal bytes, or of twelve or more `0x` bytes, twelve or more hex bytes in a run (either
 * case, `0x` or not) or spaced, the key as two 8-byte hex halves, and a 16-byte value in base64,
 * padded or not, base64url included (plan 2b review M4). Unpadded, that is any 22 such characters
 * with both cases, so a mixed-case word of exactly that length is lost from the log too (re-review
 * N2). Short runs (an 8-byte extended PAN id or an IEEE address written `0x…`, a 2-byte address)
 * stay only when they are no Buffer.
 */
export function redact(text: string): string {
  return text
    .replace(/\{\s*"type"\s*:\s*"Buffer"\s*,\s*"data"\s*:\s*\[[^\]]*\]\s*\}/g, "<buffer>")
    .replace(/(?:0x[0-9a-fA-F]{1,2}[\s,;:]+){11,}0x[0-9a-fA-F]{1,2}(?![0-9a-fA-F])/g, "<bytes>")
    .replace(/(?<![0-9A-Za-z])[0-9a-fA-F]{16}[\s:,;-]+[0-9a-fA-F]{16}(?![0-9A-Za-z])/g, "<hex>")
    .replace(/(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]{22}(?![A-Za-z0-9+/_=-]))(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{22}/g, "<base64>")
    .replace(/\[(?:\s*\d{1,3}\s*,){11,}\s*\d{1,3}\s*\]/g, "[<bytes>]")
    .replace(/(?:\d{1,3}\s*,\s*){11,}\d{1,3}/g, "<bytes>")
    .replace(/(?:0x)?[0-9a-fA-F]{24,}/g, "<hex>")
    .replace(/(?<![0-9A-Za-z])(?:[0-9a-fA-F]{2}[ :-]){11,}[0-9a-fA-F]{2}(?![0-9A-Za-z])/g, "<hex>")
    .replace(/[A-Za-z0-9+/]{22}==/g, "<base64>");
}

/**
 * herdsman's `Logger` (its `setLogger`), as its type has it; the converters' is the same, but that
 * its `error` also takes a lambda.
 */
export interface HerdsmanLogger {
  debug(messageOrLambda: string | (() => string), namespace: string): void;
  info(messageOrLambda: string | (() => string), namespace: string): void;
  warning(messageOrLambda: string | (() => string), namespace: string): void;
  error(messageOrLambda: string | (() => string), namespace: string): void;
}

export interface LogOptions {
  /** Writes one finished line. */
  write(line: string): void;
  /** Whether herdsman's debug lines are kept, the frame dumps never among them. */
  debug?: boolean;
  /** The time a line is stamped with. */
  now?: () => number;
}

/** A logger for herdsman's `setLogger`: frame dumps dropped, every line redacted and stamped. */
export function herdsmanLogger(o: LogOptions): HerdsmanLogger {
  const now = o.now ?? Date.now;
  const line = (level: string, m: string | (() => string), ns: string) => {
    let text: string;
    try {
      text = typeof m === "function" ? m() : String(m);
    } catch (err) {
      text = `(a log line that could not be made: ${String((err as Error)?.message ?? err)})`;
    }
    o.write(`${new Date(now()).toISOString()} ${level} ${ns} ${redact(text)}`);
  };
  return {
    debug: (m, ns) => {
      if (!o.debug || FRAME_DUMPS.test(ns)) return;
      line("debug", m, ns);
    },
    info: (m, ns) => line("info", m, ns),
    warning: (m, ns) => line("warn", m, ns),
    error: (m, ns) => line("error", m, ns),
  };
}

/**
 * Makes `herdsmanLogger(o)` the logger of herdsman and of the converters, for every line they write
 * from here on: a converter's line can quote a frame, and a frame can carry the key.
 */
export function useHerdsmanLogger(o: LogOptions): void {
  const logger = herdsmanLogger(o);
  setLogger(logger);
  setConvertersLogger(logger);
}
