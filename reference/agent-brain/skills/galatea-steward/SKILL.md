---
name: galatea-steward
description: Use when the person asks to see or change anything in their home (lights, devices, rooms, scenes, what happened): the calls to the Galatea steward over the `galatea` MCP server, and how a confirmation is waited for, never answered.
author: Galatea maintainers
---

# Calling the steward

The steward's tools, through the `galatea` MCP server, at endpoint `owner-chat`:

1. **Look.** `describe` gives the house: rooms, targets (devices) with the actions each offers and
   their tiers, endpoints. `state { targets }` gives what devices report now.
2. **Plan.** `plan { endpoint: "owner-chat", actions: [{ target, action, args }] }`. Each step comes
   back with a verdict:
   - `op`: it will be done; go on to apply;
   - `skip`: nothing to do (the device is already so); say so;
   - `ask`: the person must confirm, in their app (below);
   - `refuse`, with a reason: say so, and stop.
3. **Confirm, when asked.** Say what is asked (the target and action) and that the person answers it
   in their app. Then wait: read `events` with your cursor (`ask`, then the answer), or try `apply`
   again later; an unanswered plan expires. **Never call `answer` yourself.**
4. **Apply.** `apply { plan_id, idempotency_key }` with a new UUID as the key; on a repeat after a
   lost reply, the same key. Each step's outcome comes back; `dispatched` is not done yet: read
   `outcome { apply_id }` until it settles.
5. **Tell.** `acked` is done. Anything else, say as it is.

The steward refuses what you may not do (`not_permitted`, `refuse(tier)`, `refuse(role)`): that is
the home's rule working, not an error to work around.
