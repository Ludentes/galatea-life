import { RequestError } from "../core/errors.js";
import { digest, sameSecret } from "../core/secret.js";
import type { Credential, Endpoint, EndpointType, House, Role } from "../house/model.js";
import type { Mutation } from "../mutations.js";

/** Who called: a registered credential, or nobody the steward knows (GA-AUTH-4). */
export type Caller = { kind: "credential"; credential: Credential } | { kind: "anonymous" };

/**
 * The credential whose secret is `bearer`, resolved on every request from the model as it is now.
 * Every kept digest is compared, each in constant time, so the time a refusal takes says nothing
 * about which credential came close.
 */
export function resolveCaller(house: House, bearer: string | undefined): Caller {
  if (!bearer) return { kind: "anonymous" };
  const d = digest(bearer);
  let found: Credential | undefined;
  for (const c of house.credentials.values()) if (sameSecret(c.secret_sha256, d)) found = c;
  return found ? { kind: "credential", credential: found } : { kind: "anonymous" };
}

/**
 * The endpoints a credential is bound to (steward, *Clients, endpoints and principals*): an app's or
 * a panel's one endpoint; a brain's, those whose `served_by` names it; a front's, those whose voice
 * record's `heard_by` names it (GA-AUTH-8).
 */
export function boundEndpoints(house: House, c: Credential): Endpoint[] {
  const all = [...house.endpoints.values()];
  switch (c.kind) {
    case "app":
    case "panel": return all.filter((e) => e.id === c.endpoint);
    case "brain": return all.filter((e) => e.served_by === c.id);
    case "front": return all.filter((e) => e.voice?.heard_by === c.id);
  }
}

const RANK: Record<Role, number> = { visitor: 0, guest: 1, member: 2, owner: 3 };

export const lowerRole = (a: Role, b: Role): Role => (RANK[a] <= RANK[b] ? a : b);

/**
 * An endpoint's cap when the owner set none (steward, *Clients, endpoints and principals*): no cap
 * with a person, `visitor` with a `skill_account`, else `member` for a voice endpoint and `guest`
 * for a panel. An app always has a person (GA-DEF-8).
 */
export function maxRoleOf(e: Endpoint): Role {
  if (e.max_role) return e.max_role;
  if (e.person) return "owner";
  if (e.voice?.skill_account) return "visitor";
  return e.type === "voice" ? "member" : "guest";
}

/** A person at an endpoint, as the steward derives it from the request (GA-AUTH-1, GA-AUTH-2). */
export interface Principal {
  endpoint: string;
  /** The endpoint's person, or the speaker a brain named; null: a guest. */
  person: string | null;
  /** The person was named by a brain as its speaker: the brain's claim, recorded as such. */
  speaker?: string;
  /** The endpoint's type, or `rule` for a rule's own principal (GA-AUTH-5). */
  via: EndpointType | "rule" | "schedule";
  /** Whether a brain serves the endpoint. */
  brain: boolean;
  role: Role;
}

/**
 * The principal of a request that names `endpoint`, and maybe `speaker`, from credential `c`. An
 * endpoint the credential is not bound to is `not_permitted` (GA-AUTH-1); a `speaker` is accepted
 * only from a brain credential at a brain-served endpoint with no person, naming a registered
 * person, and is otherwise `invalid_request` (GA-AUTH-2). The role is the lower of the person's and
 * the endpoint's cap; no person is a guest. `trusts-asserted-via` takes any endpoint of the house as
 * the credential's; `takes-any-speaker` takes any speaker from anyone.
 */
export function principalOf(house: House, c: Credential, endpoint: string, speaker?: string, mutation?: Mutation): Principal {
  const e = mutation === "trusts-asserted-via" ? house.endpoints.get(endpoint) : boundEndpoints(house, c).find((x) => x.id === endpoint);
  if (!e) throw new RequestError("not_permitted", `endpoint ${endpoint} is not bound to this credential`);
  let person = e.person;
  if (speaker !== undefined) {
    if (mutation !== "takes-any-speaker") {
      if (c.kind !== "brain" || !e.served_by || e.person) {
        throw new RequestError("invalid_request", "a speaker is named only by a brain, at an endpoint it serves that has no person");
      }
      if (!house.persons.has(speaker)) throw new RequestError("invalid_request", `speaker ${speaker} is not a registered person`);
    }
    person = speaker;
  }
  const own: Role = person ? house.persons.get(person)?.role ?? "guest" : "guest";
  return { endpoint: e.id, person, ...(speaker !== undefined ? { speaker } : {}), via: e.type, brain: e.served_by !== null,
    role: lowerRole(own, maxRoleOf(e)) };
}
