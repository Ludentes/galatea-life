#!/usr/bin/env node
// The bench's freshness watch (plan 5b; the coordinator bench guide, *Freshness: polls and configured
// reports*). It reads nothing but what the bridge publishes: every `status` and `devices` under
// GALATEA_ROOT, from GALATEA_BROKER, and sends nothing. Each roster entry seen is appended to
// $WATCH_OUT (JSON lines, one per device per status) and, on Ctrl-C or after WATCH_HOURS, a summary per
// device is printed: how the bridge says it learns of it (basis, cadence, bound), the check-ins seen
// (distinct lastCheckIn values), the longest and the median gap between them, and how long it was not
// observable. The gaps are what the bench measures: whether a configured report is honoured, and the
// rhythm a model reports at on its own. A status comes every 10 s, so check-ins closer than that
// collapse into one, and every gap is read to within 10 s.
//
// Run from reference/zigbee-bridge, so that `mqtt` resolves:
//   GALATEA_BROKER=mqtt://127.0.0.1:18830 GALATEA_ROOT=bench WATCH_OUT=$HOME/freshness.jsonl WATCH_HOURS=12 \
//     node bench/freshness-watch.mjs
// The output names devices by the bridge's ids and models only; keep it with the owner's records.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** A roster entry as one sample: the status's time and the fields the watch reads. */
export function sample(status, entry, models) {
  return {
    at: status.publishedAt, id: entry.id, model: models.get(entry.id) ?? null, basis: entry.basis, cadenceMs: entry.cadenceMs,
    basisMaxAgeMs: entry.basisMaxAgeMs, lastCheckIn: entry.lastCheckIn, observable: entry.observable,
  };
}

/**
 * The summary of a device's samples, in the order they were seen: its last basis, cadence and bound;
 * its check-ins (distinct lastCheckIn values) and the gaps between them, in seconds; and how long it
 * was not observable, from the first sample that said so to the next that did not (or the last).
 */
export function summarise(samples) {
  const byDevice = new Map();
  for (const s of samples) {
    if (!byDevice.has(s.id)) byDevice.set(s.id, []);
    byDevice.get(s.id).push(s);
  }
  const out = [];
  for (const [id, ss] of byDevice) {
    const last = ss.at(-1);
    const checkIns = [...new Set(ss.map((s) => s.lastCheckIn).filter((t) => typeof t === "string"))].map((t) => Date.parse(t)).sort((a, b) => a - b);
    const gaps = checkIns.slice(1).map((t, i) => (t - checkIns[i]) / 1000);
    const sorted = [...gaps].sort((a, b) => a - b);
    let unobservableMs = 0;
    let since;
    for (const s of ss) {
      const at = Date.parse(s.at);
      if (!s.observable && since === undefined) since = at;
      if (s.observable && since !== undefined) {
        unobservableMs += at - since;
        since = undefined;
      }
    }
    if (since !== undefined) unobservableMs += Date.parse(last.at) - since;
    out.push({
      id, model: last.model, basis: last.basis, cadenceMs: last.cadenceMs, basisMaxAgeMs: last.basisMaxAgeMs,
      from: ss[0].at, to: last.at, checkIns: checkIns.length,
      longestGapS: sorted.length ? sorted.at(-1) : null, medianGapS: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      unobservableS: unobservableMs / 1000,
      // Whether every gap fit the bound declared at the end: a configured report honoured, or a poll answered.
      withinBound: last.basisMaxAgeMs === null || !sorted.length ? null : sorted.at(-1) * 1000 <= last.basisMaxAgeMs,
    });
  }
  return out;
}

async function main() {
  const { connect } = await import("mqtt");
  const root = process.env.GALATEA_ROOT ?? "bench";
  const outFile = process.env.WATCH_OUT;
  if (!process.env.GALATEA_BROKER || !outFile) {
    console.error("GALATEA_BROKER and WATCH_OUT are required");
    process.exit(2);
  }
  const samples = [];
  const models = new Map();
  const client = connect(process.env.GALATEA_BROKER, { protocolVersion: 5, clean: true });
  client.on("connect", () => client.subscribe([`${root}/bridges/+/status`, `${root}/bridges/+/devices`]));
  client.on("message", (topic, payload) => {
    let p;
    try {
      p = JSON.parse(payload.toString());
    } catch {
      return;
    }
    if (!p) return;
    if (topic.endsWith("/devices")) {
      for (const d of p.devices ?? []) models.set(d.id, `${d.model?.vendor ?? ""}/${d.model?.model ?? ""}`);
      return;
    }
    for (const e of p.devices ?? []) {
      const s = sample(p, e, models);
      samples.push(s);
      appendFileSync(outFile, `${JSON.stringify(s)}\n`);
    }
  });
  const end = () => {
    console.log(JSON.stringify(summarise(samples), null, 2));
    client.end(true, () => process.exit(0));
  };
  process.on("SIGINT", end);
  const hours = Number(process.env.WATCH_HOURS ?? "0");
  if (hours > 0) setTimeout(end, hours * 3_600_000);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
