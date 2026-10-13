import { MUTATIONS, type Mutation, type ZigbeeBridgeOptions } from "./bridge.js";

/**
 * The build's own mutations, not claimed in `subject.json`: each breaks a rule no row of the
 * standard's *Negative subjects* table names yet, and the harness fails a claimed mutation no row
 * names. Honoured only under a run, as the claimed ones are, and caught by the build's own tests.
 * `leaves-a-reading-unmarked` declares no vocabulary key `selfChanging`, so that every sensor
 * reading is `external` and leases its device, as before FL-GAP-2 (`selfChangingKeys`).
 * `marks-a-battery-device-dead` keys the availability rule to polling, not to the device (the
 * herdsman doer's `availability.ts`). Each is claimed once bridge 0.7 names its rule.
 */
export const UNCLAIMED_MUTATIONS = ["leaves-a-reading-unmarked", "marks-a-battery-device-dead"] as const;
export type UnclaimedMutation = (typeof UNCLAIMED_MUTATIONS)[number];

/** The build's own mutations that a doer honours, not the core: only the herdsman doer honours them. */
export const DOER_MUTATIONS: readonly UnclaimedMutation[] = ["marks-a-battery-device-dead"];

/**
 * The negative mutation `env` asks for (`GALATEA_MUTATION`), or why the bridge refuses to start: a
 * mutation is honoured only under a run (`GALATEA_TEST_RUN_ID`), and only one this build implements
 * (conformance/README.md, *Negative mutations*), claimed or its own. A mutation a doer honours
 * (`DOER_MUTATIONS`) is honoured only by the herdsman doer: under the scripted doer (`scripted`) it
 * would be ignored silently, so it is refused.
 */
export function mutationFromEnv(env: Record<string, string | undefined>, scripted = false): { mutation?: Mutation | UnclaimedMutation } | { refused: string } {
  const mutation = env.GALATEA_MUTATION;
  if (!mutation) return {};
  if (!env.GALATEA_TEST_RUN_ID) return { refused: `GALATEA_MUTATION ${mutation} is set without GALATEA_TEST_RUN_ID` };
  if (!([...MUTATIONS, ...UNCLAIMED_MUTATIONS] as readonly string[]).includes(mutation)) return { refused: `no mutation ${mutation} in this build` };
  if (scripted && (DOER_MUTATIONS as readonly string[]).includes(mutation)) {
    return { refused: `GALATEA_MUTATION ${mutation} is honoured only by the herdsman doer, not the scripted one` };
  }
  return { mutation: mutation as Mutation | UnclaimedMutation };
}

/** Whether a mutation is one the core honours (claimed), rather than the build's own. */
export function claimed(mutation: Mutation | UnclaimedMutation): mutation is Mutation {
  return (MUTATIONS as readonly string[]).includes(mutation);
}

/** The core's option for each of the build's own mutations; one a doer honours maps to none. */
const UNCLAIMED_BRIDGE_OPTIONS: Partial<Record<UnclaimedMutation, Pick<ZigbeeBridgeOptions, "leavesReadingsUnmarked">>> = {
  "leaves-a-reading-unmarked": { leavesReadingsUnmarked: true },
};

/**
 * What the core's options carry for a mutation: a claimed one as `mutation`, the build's own each as
 * its option (`UNCLAIMED_BRIDGE_OPTIONS`); none for a mutation the core does not honour (one a
 * doer honours, or none at all).
 */
export function bridgeMutationOptions(mutation: Mutation | UnclaimedMutation | undefined):
  Pick<ZigbeeBridgeOptions, "mutation" | "leavesReadingsUnmarked"> {
  if (mutation === undefined) return {};
  if (claimed(mutation)) return { mutation };
  return UNCLAIMED_BRIDGE_OPTIONS[mutation] ?? {};
}
