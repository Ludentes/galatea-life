import { createHash } from "node:crypto";

/**
 * A name-based UUID, RFC 9562's version 5 (SHA-1 of the namespace's 16 bytes and the name): the same
 * command, named by what started it, gets the same id in every life (the maintainer's ruling 2, 2026-10-05),
 * and the bridge's GA-BRIDGE-4 memory drops it when it is sent again. A UUID whatever the name's length.
 */
export function uuidV5(name: string, namespace: string): string {
  const h = createHash("sha1").update(Buffer.from(namespace.replace(/-/g, ""), "hex")).update(name, "utf8").digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
