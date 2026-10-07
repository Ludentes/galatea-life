import type { Candidate, FinderView } from "./finder.js";

/** A registered bridge as an offer reads it: its latest status taken, and whether it is live. */
export type BridgeOffer = { id: string; alive: boolean; levels: string[]; bridge_type?: string };

/** A candidate as `candidates` lists it: the finder's, with the live bridges of this applier that could take it. */
export type Listed = Candidate & { offers: { bridge_type: string; connect: boolean; bridges: string[] }[] };

/**
 * What `candidates` lists (applier, *Discovery*, GA-DISC-2): pure, and the one place it is decided, so
 * `candidates`, `ignore_candidate` and `connect` agree. A candidate sharing a key with a connection
 * `held` by any registered bridge, live or dead, or with an ignored key, is not listed; each match
 * offers this applier's live bridges of its type, those claiming Provision where it says `connect`.
 */
export const Discovery = {
  list(v: FinderView, held: Set<string>, ignored: Set<string>, bridges: BridgeOffer[]): Listed[] {
    return v.candidates
      .filter((c) => !c.keys.some((k) => held.has(k) || ignored.has(k)))
      .map((c) => ({ ...c, offers: c.matches.map((m) => ({ bridge_type: m.bridge_type, connect: m.connect,
        bridges: bridges.filter((b) => b.alive && b.bridge_type === m.bridge_type && (!m.connect || b.levels.includes("Provision")))
          .map((b) => b.id).sort() })) }));
  },
  listed: (list: Listed[], id: string): Listed | undefined => list.find((c) => c.id === id),
};
