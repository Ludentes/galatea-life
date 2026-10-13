// The applier's operations as the binding lists them, and who may call each (moved from applier.ts).
import { toolInputSchemaFor } from "@ludentes/galatea-life-schemas";
import type { Tool } from "./service.js";

// No combinator at the schema's top level, or Claude Code drops the tool; the alternatives it took
// out are said in the summary, and each call is still validated in full.
const op = (name: string, readOnly: boolean, summary: string): Tool => {
  const inputSchema = toolInputSchemaFor("applier", name);
  const alternatives = typeof inputSchema.description === "string" ? ` ${inputSchema.description}` : "";
  return { name, readOnly, summary: `${summary}${alternatives}`, inputSchema };
};

/**
 * The applier's operations (applier, *Operations*), as its MCP binding lists them, each with its
 * request schema, so a model sees each parameter's name and type. An operation with no request
 * schema throws here, so the applier fails at start rather than list it untyped.
 */
export const TOOLS: readonly Tool[] = [
  op("describe", true, "The applier: its devices, their actions and tiers, transports, safety rules, clients and revision"),
  op("state", true, "Current values of targets, with each device's liveness and freshness, each transport's state and the latches held"),
  op("plan", true, "Plan actions on targets; changes nothing, returns each step's verdict and a plan id to apply"),
  op("apply", false, "Carry out a plan by its id, or a request directly, under an idempotency key; returns the apply id and its outcomes"),
  op("outcome", true, "The current outcomes of an apply, late ones included"),
  op("events", true, "Events after a cursor, waiting up to wait_s for one, with the notices due"),
  op("history", true, "Past events of targets between two times"),
  op("configure", false, "The owner's changes to the configuration at an expected revision; a dry run returns a readable diff"),
  op("provision", false, "The owner's provisioning: open a join window, commission, connect, install or remove a device or plugin"),
  op("candidates", true, "Devices the finder has seen that no bridge holds yet, offered to the owner"),
];

/** What the owner's configuration credential may call (applier, *Clients and tokens*). */
export const OWNER_TOOLS = new Set(["describe", "state", "events", "history", "configure", "provision", "candidates"]);

export const CLIENT_TOOLS = new Set(["describe", "state", "plan", "apply", "outcome", "events", "history"]);
