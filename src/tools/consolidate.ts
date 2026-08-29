import { z } from "zod";
import {
  clusterMemories,
  createDerivedMemory,
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
  const clusters = clusterMemories({
    threshold: typeof args.threshold === "number" ? args.threshold : undefined,
    projectId:
      typeof args.projectId === "string" ? args.projectId : null,
    minClusterSize:
      typeof args.minClusterSize === "number"
        ? args.minClusterSize
        : undefined,
  });

  const lines: string[] = [];
  const derivedIds: number[] = [];
  for (const c of clusters) {
    const contents = c.map((id) => {
      const m = db
        .prepare("SELECT content FROM memories WHERE id = ?")
        .get(id) as { content: string } | undefined;
      return `  - [${id}] ${m?.content ?? "?"}`;
    });
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
      const summary = c
        .map((id) => {
          const m = db
            .prepare("SELECT content FROM memories WHERE id = ?")
            .get(id) as { content: string } | undefined;
          return m?.content ?? "";
        })
        .join(" | ");
      const did = createDerivedMemory({
        content: `Consolidated: ${summary}`,
        sourceIds: c,
      });
      derivedIds.push(did);
      lines.push(`  => derived memory id=${did}`);
    }
  }

  const header = `Found ${clusters.length} cluster(s)${
    args.derive === true
      ? `, created ${derivedIds.length} derived memories`
      : ""
  }`;
  return ok(header + "\n\n" + (lines.join("\n\n") || "(no clusters)"));
}
