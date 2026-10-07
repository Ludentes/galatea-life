import { describe, expect, it } from "vitest";
import { digest } from "../src/core/secret.js";
import { emptyHouse, FIRST_OWNER, houseKey, loadHouse, saveHouse, withFirstOwner } from "../src/house/model.js";
import { baseline, furnished, SECRETS } from "./house.js";
import { memoryStore } from "./db.js";

describe("the house model", () => {
  it("keeps every object, and a secret's digest only, across a save and a load, safe to save twice", async () => {
    const store = await memoryStore();
    const h = furnished();
    await store.write((tx) => saveHouse(tx, h));
    await store.write((tx) => saveHouse(tx, h));
    const back = await loadHouse(store);
    expect(houseKey(back)).toBe(houseKey(h));
    const rows = await store.query<{ doc: unknown }>("SELECT doc FROM house WHERE kind = 'credential'");
    expect(JSON.stringify(rows.rows)).not.toContain(SECRETS.brain);
  });

  it("makes the first owner: a person, an app endpoint with no room served by no brain, and its credential (Q2)", () => {
    const h = withFirstOwner(emptyHouse(), SECRETS.owner);
    expect(h.persons.get(FIRST_OWNER.person)).toEqual({ id: "owner", name: "Owner", role: "owner" });
    expect(h.endpoints.get(FIRST_OWNER.endpoint)).toEqual({ id: "owner-app", name: "Owner's app", type: "app", room: null,
      person: "owner", served_by: null, voice: null });
    expect(h.credentials.get(FIRST_OWNER.credential)).toEqual({ id: "owner-app", kind: "app", secret_sha256: digest(SECRETS.owner),
      endpoint: "owner-app" });
  });

  it("has a key that moves with any change, and not with the order things were added in", () => {
    const a = baseline();
    const b = baseline();
    b.rooms = new Map([...b.rooms].reverse());
    expect(houseKey(a)).toBe(houseKey(b));
    b.rooms.get("hall")!.name = "Прихожая";
    expect(houseKey(a)).not.toBe(houseKey(b));
  });
});
