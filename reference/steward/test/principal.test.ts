import { describe, expect, it } from "vitest";
import { boundEndpoints, lowerRole, principalOf, resolveCaller } from "../src/auth/principal.js";
import { planDefine } from "../src/house/define.js";
import { baseline, context, SECRETS, up } from "./house.js";

const credential = (h: ReturnType<typeof baseline>, id: string) => h.credentials.get(id)!;

describe("callers and principals", () => {
  it("resolves a bearer to its credential, and anything else to nobody (GA-AUTH-4)", () => {
    const h = baseline();
    expect(resolveCaller(h, SECRETS.brain)).toEqual({ kind: "credential", credential: credential(h, "brain") });
    expect(resolveCaller(h, "not-a-secret-of-anyone")).toEqual({ kind: "anonymous" });
    expect(resolveCaller(h, undefined)).toEqual({ kind: "anonymous" });
  });

  it("binds an app and a panel to their endpoint, a brain to those it serves, a front to those it hears", () => {
    const h = baseline();
    const ids = (c: string) => boundEndpoints(h, credential(h, c)).map((e) => e.id).sort();
    expect([ids("owner-app"), ids("hall-panel"), ids("brain"), ids("front")])
      .toEqual([["owner-app"], ["hall-panel"], ["kitchen-voice"], ["kitchen-voice"]]);
  });

  it("derives via, brain and the role from the endpoint, never from the client (GA-AUTH-1, GA-AUTH-2)", () => {
    const h = baseline();
    expect(principalOf(h, credential(h, "owner-app"), "owner-app"))
      .toEqual({ endpoint: "owner-app", person: "owner", via: "app", brain: false, role: "owner" });
    expect(principalOf(h, credential(h, "olga-app"), "olga-app")).toMatchObject({ person: "olga", role: "member" });
    expect(principalOf(h, credential(h, "hall-panel"), "hall-panel")).toMatchObject({ person: null, via: "panel", role: "guest" });
    expect(principalOf(h, credential(h, "brain"), "kitchen-voice")).toMatchObject({ person: null, via: "voice", brain: true, role: "guest" });
    expect(() => principalOf(h, credential(h, "brain"), "hall-panel")).toThrow(expect.objectContaining({ code: "not_permitted" }));
  });

  it("takes a speaker only from a brain at an endpoint it serves with no person, naming a registered person", () => {
    const h = baseline();
    expect(principalOf(h, credential(h, "brain"), "kitchen-voice", "olga")).toMatchObject({ person: "olga", speaker: "olga", role: "member" });
    expect(() => principalOf(h, credential(h, "brain"), "kitchen-voice", "nobody")).toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(() => principalOf(h, credential(h, "olga-app"), "olga-app", "olga")).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });

  it("caps the role at the endpoint's max_role, its default by kind", () => {
    const h = planDefine(baseline(), [up("endpoint", { id: "kitchen-voice", name: "Кухня", type: "voice", room: "kitchen", person: null,
      served_by: "brain", max_role: "guest" })], context()).draft;
    expect(principalOf(h, credential(h, "brain"), "kitchen-voice", "owner").role).toBe("guest");
    // A voice endpoint's default cap is member: an owner named there is a member.
    expect(principalOf(baseline(), credential(baseline(), "brain"), "kitchen-voice", "owner").role).toBe("member");
    expect(lowerRole("owner", "visitor")).toBe("visitor");
  });

  it("takes an endpoint the credential is not bound to under trusts-asserted-via, as that endpoint", () => {
    const h = baseline();
    expect(principalOf(h, credential(h, "brain"), "hall-panel", undefined, "trusts-asserted-via"))
      .toEqual({ endpoint: "hall-panel", person: null, via: "panel", brain: false, role: "guest" });
    expect(() => principalOf(h, credential(h, "brain"), "nowhere", undefined, "trusts-asserted-via"))
      .toThrow(expect.objectContaining({ code: "not_permitted" }));
  });

  it("takes any speaker from anyone under takes-any-speaker", () => {
    const h = baseline();
    expect(principalOf(h, credential(h, "hall-panel"), "hall-panel", "owner", "takes-any-speaker")).toMatchObject({ person: "owner", speaker: "owner" });
    expect(principalOf(h, credential(h, "brain"), "kitchen-voice", "nobody", "takes-any-speaker")).toMatchObject({ person: "nobody", role: "guest" });
  });
});

