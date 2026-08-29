import { z } from "zod";
import { getContext } from "../core/context-engine.js";
import { ok } from "../db/index.js";

export const contextInput = {
  query: z
    .string()
    .optional()
    .describe("Optional focus query to seed hybrid retrieval"),
  projectId: z
    .string()
    .nullable()
    .optional()
    .describe("Scope context to a project"),
  sessionId: z.string().nullable().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Number of seed memories (default 10)"),
  maxTokens: z
    .number()
    .int()
    .min(100)
    .max(8000)
    .optional()
    .describe("Token budget for assembled context (default 2000)"),
  includeHistory: z
    .boolean()
    .optional()
    .describe("Include superseded/archived memories"),
  includeGraph: z
    .boolean()
    .optional()
    .describe("Expand seeds with memory-graph neighbors"),
};

export function contextHandler(args: Record<string, unknown>) {
  const res = getContext({
    query: typeof args.query === "string" ? args.query : "",
    projectId:
      typeof args.projectId === "string" ? args.projectId : null,
    sessionId:
      typeof args.sessionId === "string" ? args.sessionId : null,
    limit: typeof args.limit === "number" ? args.limit : undefined,
    maxTokens:
      typeof args.maxTokens === "number" ? args.maxTokens : undefined,
    includeHistory: args.includeHistory === true,
    includeGraph: args.includeGraph === true,
  });

  const lines = res.memories.map((m) => {
    const meta = m.metadata ? ` meta=${m.metadata}` : "";
    const tag = m.viaGraph ? " [graph]" : "";
    return `[${m.id}] (${m.type}/${m.status})${tag} ${m.content}${meta}`;
  });

  const header = `Context for "${res.query || "<no query>"}" — ${
    res.memories.length
  } memories, ~${res.tokenEstimate} tokens${
    res.truncated ? " (truncated to budget)" : ""
  }`;

  return ok(header + "\n\n" + (lines.join("\n") || "(no memories)"));
}
