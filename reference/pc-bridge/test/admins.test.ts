import { describe, expect, it } from "vitest";
import { reduceAdmins, sameAdmins, withUnknown } from "../src/admins.js";
import type { AdminFacts, OsAccount } from "../src/port.js";
import { emptyTokens, see, tokenOf } from "../src/tokens.js";

const listed: OsAccount[] = [
  { osId: 1000, name: "liza", primaryGid: 1000 },
  { osId: 1001, name: "John.Doe", primaryGid: 1001 },
  { osId: 1002, name: "olga", primaryGid: 1002 },
];
const polkit = (over: Partial<AdminFacts["polkit"]> = {}): AdminFacts["polkit"] => ({ users: [], groups: [], unresolved: [], unrecognised: false, ...over });
const facts = (over: Partial<AdminFacts> = {}): AdminFacts => ({ groups: [], sudo: [], polkit: polkit(), ...over });

/** The reduction over a fresh table, the listed accounts seen first as the bridge sees them. */
function reduce(f: AdminFacts) {
  const table = emptyTokens();
  for (const a of listed) see(table, a.osId, a.name, true);
  const labels = reduceAdmins(f, (osId, name) => {
    see(table, osId, name, false);
    return tokenOf(table, osId)!;
  }).map((a) => a.label);
  return { labels, table };
}

describe("reduceAdmins", () => {
  it("lists root alone on a machine with no other administrator, with a token accounts does not list", () => {
    const { labels, table } = reduce(facts());
    expect(labels).toEqual(["root"]);
    expect(table.accounts["0"]).toEqual({ token: "root", name: "root", interactive: false });
  });

  it.each(["sudo", "wheel", "admin", "docker"])("lists every member of %s by token", (name) => {
    const { labels } = reduce(facts({ groups: [{ name, gid: 27, members: [{ osId: 1001, name: "John.Doe" }] }] }));
    expect(labels).toEqual(["root", "u1001"]);
  });

  it("lists no member of another group", () => {
    const { labels } = reduce(facts({ groups: [{ name: "audio", gid: 29, members: [{ osId: 1000, name: "liza" }] }] }));
    expect(labels).toEqual(["root"]);
  });

  it("lists an account sudo lets run one command as root, and a service account by a token of the same table", () => {
    const { labels, table } = reduce(facts({ sudo: [
      { osId: 1000, name: "liza", root: "yes" }, { osId: 1002, name: "olga", root: "no" }, { osId: 34, name: "backup", root: "yes" },
    ] }));
    expect(labels).toEqual(["backup", "liza", "root"]);
    expect(table.accounts["34"]!.interactive).toBe(false);
  });

  it("adds unknown for a sudo answer it cannot tell, and for a polkit file it does not recognise", () => {
    expect(reduce(facts({ sudo: [{ osId: 1000, name: "liza", root: "cannotTell" }] })).labels).toEqual(["root", "unknown"]);
    expect(reduce(facts({ polkit: polkit({ unrecognised: true }) })).labels).toEqual(["root", "unknown"]);
  });

  it("lists polkit's users by token and its groups by g and the gid, never a user's token for a gid", () => {
    const { labels } = reduce(facts({ polkit: polkit({ users: [{ osId: 1002, name: "olga" }], groups: [{ name: "operators", gid: 1000 }] }) }));
    // The group's gid is liza's uid, and liza is not in the list.
    expect(labels).toEqual(["g1000", "olga", "root"]);
  });

  it("adds unknown for a polkit identity the OS could not resolve", () => {
    expect(reduce(facts({ polkit: polkit({ unresolved: ["unix-user:ghost"] }) })).labels).toEqual(["root", "unknown"]);
    expect(reduce(facts({ polkit: polkit({ unresolved: ["unix-netgroup:ops"] }) })).labels).toEqual(["root", "unknown"]);
  });

  it("adds unknown where the OS says the set cannot be enumerated in full (review I1), and not for an empty list", () => {
    expect(reduce(facts({ incomplete: ["nsswitch.conf names a directory for passwd"] })).labels).toEqual(["root", "unknown"]);
    expect(reduce(facts({ incomplete: [] })).labels).toEqual(["root"]);
  });

  it("lists polkit's root, and a service account the OS resolved, by the table's tokens", () => {
    const { labels, table } = reduce(facts({ polkit: polkit({ users: [{ osId: 0, name: "root" }, { osId: 5, name: "games" }] }) }));
    expect(labels).toEqual(["games", "root"]);
    expect(table.accounts["5"]).toEqual({ token: "games", name: "games", interactive: false });
  });

  it("names each administrator once", () => {
    const { labels } = reduce(facts({
      groups: [{ name: "sudo", gid: 27, members: [{ osId: 1000, name: "liza" }] }, { name: "docker", gid: 999, members: [{ osId: 1000, name: "liza" }] }],
      sudo: [{ osId: 1000, name: "liza", root: "yes" }],
      polkit: polkit({ users: [{ osId: 1000, name: "liza" }] }),
    }));
    expect(labels).toEqual(["liza", "root"]);
  });
});

describe("after a failed read", () => {
  it("keeps the last set and adds unknown once", () => {
    const last = [{ vendor: "os", label: "root" }, { vendor: "os", label: "liza" }];
    expect(withUnknown(last).map((a) => a.label)).toEqual(["liza", "root", "unknown"]);
    expect(withUnknown(withUnknown(last))).toEqual(withUnknown(last));
  });

  it("compares sets whatever their order", () => {
    expect(sameAdmins([{ vendor: "os", label: "a" }, { vendor: "os", label: "b" }], [{ vendor: "os", label: "b" }, { vendor: "os", label: "a" }])).toBe(true);
    expect(sameAdmins([{ vendor: "os", label: "a" }], [{ vendor: "os", label: "a" }, { vendor: "os", label: "unknown" }])).toBe(false);
  });
});
