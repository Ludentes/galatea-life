import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { Tool } from "@modelcontextprotocol/server";

const NO_ARGS = { type: "object" as const, properties: {}, additionalProperties: false };

export const TOOLS: Tool[] = [
  {
    name: "launch",
    title: "Play a film or an episode",
    description:
      "Plays the best match for the title among the video files in the folders the owner configured. " +
      "Takes no path and no URL.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1 },
            kind: { type: "string", enum: ["movie", "episode"] },
          },
          required: ["title"],
          additionalProperties: false,
        },
      },
      required: ["search"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "pause",
    title: "Pause",
    description: "Pauses what is playing.",
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "resume",
    title: "Resume",
    description: "Resumes what is paused.",
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "set_volume",
    title: "Set the volume",
    description: "Sets the player's volume, from 0 to 100.",
    inputSchema: {
      type: "object",
      properties: { volume: { type: "integer", minimum: 0, maximum: 100 } },
      required: ["volume"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const HASHED = ["name", "title", "description", "inputSchema", "outputSchema", "annotations"] as const;

/** SHA-256, lowercase hex, over the RFC 8785 canonical JSON of the fields the standard names. */
export function toolHash(tool: Tool): string {
  const picked: Record<string, unknown> = {};
  for (const k of HASHED) if (tool[k] !== undefined) picked[k] = tool[k];
  return createHash("sha256").update(canonicalize(picked)!).digest("hex");
}
