import { MUTATIONS, type Mutation } from "./bridge.js";

/**
 * The negative mutation `env` asks for (`GALATEA_MUTATION`), or why the bridge refuses to start: a
 * mutation is honoured only under a run (`GALATEA_TEST_RUN_ID`), and only one this build implements
 * (conformance/README.md, *Negative mutations*).
 */
export function mutationFromEnv(env: Record<string, string | undefined>): { mutation?: Mutation } | { refused: string } {
  const mutation = env.GALATEA_MUTATION;
  if (!mutation) return {};
  if (!env.GALATEA_TEST_RUN_ID) return { refused: `GALATEA_MUTATION ${mutation} is set without GALATEA_TEST_RUN_ID` };
  if (!(MUTATIONS as readonly string[]).includes(mutation)) return { refused: `no mutation ${mutation} in this build` };
  return { mutation: mutation as Mutation };
}
