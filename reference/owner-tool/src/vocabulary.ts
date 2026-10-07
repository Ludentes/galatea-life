import { loadSchemas, type Schema } from "@ludentes/galatea-life-schemas";

/**
 * The words the tool checks before it sends anything, read from the standard's JSON schemas
 * (`@ludentes/galatea-life-schemas`) rather than copied, so they move with the standard (review M7):
 * the device classes and tiers of `common.json`, and the bridge id and broker identity patterns of
 * `applier/configure.bridge.json`.
 */
export interface Vocabulary {
  classes: string[];
  tiers: string[];
  bridgeId: RegExp;
  identity: RegExp;
}

let cached: Vocabulary | undefined;

export function vocabulary(): Vocabulary {
  if (cached) return cached;
  const schemas = loadSchemas();
  const byId = (id: string): Schema => {
    const s = schemas.find((x) => x.$id === id);
    if (!s) throw new Error(`the schemas package has no ${id}`);
    return s;
  };
  const defs = byId("common.json").$defs as Record<string, { enum: string[] }>;
  const bridge = byId("applier/configure.bridge.json").properties as Record<string, { pattern: string }>;
  cached = { classes: [...defs.deviceClass.enum], tiers: [...defs.tier.enum], bridgeId: new RegExp(bridge.id.pattern),
    identity: new RegExp(bridge.identity.pattern) };
  return cached;
}
