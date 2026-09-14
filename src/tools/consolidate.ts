import { z } from "zod";
import {
  clusterMemories,
  createDerivedMemory,
  resolveDerivedScope,
} from "../core/consolidation-engine.js";
import {
  linkEntitiesForMemory,
  linkMemoriesBySharedEntities,
} from "../core/entity-extractor.js";
import { db, ok } from "../db/index.js";

export const consolidateInput = {
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Cosine similarity threshold for clustering (default 0.7)"),
  projectId: z.string().nullable().optional().describe("Scope to a project"),
  // Batch B-1 (optional, additive): scope the clustering so USER/SESSION
  // memories never leak into another scope's cluster or derived memory.
  sessionId: z
    .string()
    .nullable()
    .optional()
    .describe("Scope to a session (SESSION scope)"),
  userId: z
    .string()
    .nullable()
    .optional()
    .describe("Scope to a user (USER scope)"),
  minClusterSize: z
    .number()
    .int()
    .min(2)
    .max(20)
    .optional()
    .describe("Minimum members to report a cluster (default 2)"),
  derive: z
    .boolean()
    .optional()
    .describe("Create a derived memory for each cluster"),
};

export function consolidateHandler(args: Record<string, unknown>) {
  const projectId =
    typeof args.projectId === "string" ? args.projectId : null;
  const sessionId =
    typeof args.sessionId === "string" ? args.sessionId : null;
  const userId = typeof args.userId === "string" ? args.userId : null;
  const clusters = clusterMemories({
    threshold: typeof args.threshold === "number" ? args.threshold : undefined,
    projectId,
    sessionId,
    userId,
    minClusterSize:
      typeof args.minClusterSize === "number"
        ? args.minClusterSize
        : undefined,
  });

  const lines: string[] = [];
  const derivedIds: number[] = [];
  const memberRow = db.prepare(
    "SELECT scope, project_id, session_id, user_id, content FROM memories WHERE id = ?"
  );
  for (const c of clusters) {
    const members = c.map((id) => {
      const m = memberRow.get(id) as
        | {
            scope: string;
            project_id: string | null;
            session_id: string | null;
            user_id: number | null;
            content: string;
          }
        | undefined;
      return { id, content: m?.content ?? "?", row: m };
    });
    const contents = members.map((m) => `  - [${m.id}] ${m.content}`);
    // Auto entity extraction (item 5): persist entities + co-occurrence, then
    // link memories in the cluster that share an entity.
    for (const id of c) {
      const m = db
        .prepare("SELECT content FROM memories WHERE id = ?")
        .get(id) as { content: string } | undefined;
      if (m) linkEntitiesForMemory(id, m.content);
    }
    linkMemoriesBySharedEntities(c);
    lines.push(`Cluster (${c.length}):\n${contents.join("\n")}`);
    if (args.derive === true) {
      const summary = members.map((m) => m.content).join(" | ");
      // Batch B-1: inherit the cluster's own scope — never escalate to
      // GLOBAL when a source is USER/SESSION/PROJECT.
      const scope = resolveDerivedScope(
        members.map((m) => ({
          scope: m.row?.scope ?? "GLOBAL",
          project_id: m.row?.project_id ?? null,
          session_id: m.row?.session_id ?? null,
          user_id: m.row?.user_id ?? null,
        })),
        { projectId, sessionId, userId }
      );
      if (!scope) {
        lines.push(
          `  => derived skipped (mixed unresolvable scope — not escalated to GLOBAL)`
        );
      } else {
        const did = createDerivedMemory({
          content: `Consolidated: ${summary}`,
          sourceIds: c,
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          userId: scope.userId,
        });
        derivedIds.push(did);
        lines.push(`  => derived memory id=${did}`);
      }
    }
  }

  const header = `Found ${clusters.length} cluster(s)${
    args.derive === true
      ? `, created ${derivedIds.length} derived memories`
      : ""
  }`;
  return ok(header + "\n\n" + (lines.join("\n\n") || "(no clusters)"));
}
