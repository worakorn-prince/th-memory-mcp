import { z } from "zod";
import {
  db,
  removeSearchIndex,
  removeEmbedding,
  ok,
  err,
  type ToolResult,
} from "../db/index.js";
import { getIdentity } from "../auth/identity.js";
import {
  canAccessPersonalRow,
  canAccessRow,
  getEffectiveScope,
  type ScopeRowLike,
} from "../auth/scope-resolver.js";

export const forgetInput = {
  target_id: z
    .number()
    .int()
    .positive()
    .describe("Row id to delete (id returned by remember/save_lesson)"),
  type: z
    .enum(["memory", "preference", "lesson", "interaction"])
    .optional()
    .describe(
      "Which table the id belongs to. Recommended whenever known, because numeric ids can coincide across tables."
    ),
};

const indexTables = db.prepare(
  "SELECT DISTINCT ref_table FROM search_index WHERE ref_id = ?"
);
const existsPreference = db.prepare("SELECT id FROM preferences WHERE id = ?");
const existsLesson = db.prepare("SELECT id FROM lessons WHERE id = ?");
const existsInteraction = db.prepare("SELECT id FROM interactions WHERE id = ?");
const existsMemory = db.prepare("SELECT id FROM memories WHERE id = ?");
const delPreference = db.prepare("DELETE FROM preferences WHERE id = ?");
const delLesson = db.prepare("DELETE FROM lessons WHERE id = ?");
const delInteraction = db.prepare("DELETE FROM interactions WHERE id = ?");
const delMemoryLinks = db.prepare(
  "DELETE FROM memory_links WHERE source_memory_id = ? OR target_memory_id = ?"
);
const clearRelationSource = db.prepare(
  "UPDATE relations SET source_memory_id = NULL WHERE source_memory_id = ?"
);
const clearSupersedes = db.prepare(
  "UPDATE memories SET supersedes_id = NULL WHERE supersedes_id = ?"
);
const delMemory = db.prepare("DELETE FROM memories WHERE id = ?");

// Ph-3: a by-id tool takes no scope args, so the target row's own scope
// columns decide visibility. Rows are read before any delete.
const memoryScopeRow = db.prepare(
  "SELECT scope, user_id, session_id, project_id FROM memories WHERE id = ?"
);
const preferenceOwner = db.prepare("SELECT user_id FROM preferences WHERE id = ?");
const lessonOwner = db.prepare("SELECT user_id FROM lessons WHERE id = ?");
const interactionOwner = db.prepare("SELECT user_id FROM interactions WHERE id = ?");

type Kind = "memories" | "preferences" | "lessons" | "interactions";

function existsIn(kind: Kind, id: number): boolean {
  if (kind === "memories") return !!existsMemory.get(id);
  if (kind === "preferences") {
    return !!existsPreference.get(id);
  }
  if (kind === "lessons") {
    return !!existsLesson.get(id);
  }
  return !!existsInteraction.get(id);
}

/** Owner of a personal (preferences/lessons/interactions) row, NULL = shared. */
function personalOwner(kind: Kind, id: number): number | null {
  const row =
    kind === "preferences"
      ? (preferenceOwner.get(id) as { user_id: number | null } | undefined)
      : kind === "lessons"
        ? (lessonOwner.get(id) as { user_id: number | null } | undefined)
        : (interactionOwner.get(id) as { user_id: number | null } | undefined);
  return row?.user_id ?? null;
}

export async function forgetHandler(args: {
  target_id: number;
  type?: "memory" | "preference" | "lesson" | "interaction";
}): Promise<ToolResult> {
  try {
    const id = args.target_id;
    const kindOf: Record<string, Kind> = {
      memory: "memories",
      preference: "preferences",
      lesson: "lessons",
      interaction: "interactions",
    };

    let targets: Kind[] = [];
    const typedKind = args.type ? kindOf[args.type] : undefined;
    if (typedKind) {
      targets = [typedKind];
    } else {
      const indexed = indexTables.all(id) as { ref_table: string }[];
      const evidence = indexed
        .map((r) => r.ref_table)
        .filter((t): t is Kind =>
          t === "memories" || t === "preferences" || t === "lessons" || t === "interactions"
        );
      const candidates =
        evidence.length > 0
          ? evidence
          : (["memories", "preferences", "lessons", "interactions"] as Kind[]);
      targets = candidates.filter((k) => existsIn(k, id));
    }

    if (targets.length === 0) {
      return ok(`nothing found with id=${id}`);
    }

    // Batch A-1: never silently delete across tables. Without an explicit
    // type, a numeric id can coincide in several tables (each AUTOINCREMENTs
    // from 1). If it matches >1 table, fail closed and ask for `type`.
    if (!typedKind && targets.length > 1) {
      return err(
        `ambiguous id=${id}: found in ${targets.join(", ")}. Specify type explicitly (one of memory, preference, lesson, interaction)`
      );
    }

    // Ph-3: visibility is decided per TARGET ROW (no scope args exist here).
    // The whole call is all-or-nothing: one out-of-scope target deletes nothing.
    const scope = getEffectiveScope();
    if (scope !== null) {
      const identity = getIdentity();
      for (const kind of targets) {
        const allowed =
          kind === "memories"
            ? canAccessRow(
                identity,
                (memoryScopeRow.get(id) as ScopeRowLike | undefined) ?? {
                  scope: "UNKNOWN",
                },
                "write"
              )
            : canAccessPersonalRow(identity, personalOwner(kind, id));
        if (!allowed) {
          return err("denied: forget target out of scope (auth enforced)");
        }
      }
    }

    const removed: string[] = [];
    let linksRemoved = 0;
    db.transaction(() => {
      for (const kind of targets) {
        if (!existsIn(kind, id)) continue;
        if (kind === "memories") {
          // Hard purge: remove the row and every direct reference in the same
          // transaction so no content/id survives in the DB. Graph entities and
          // relations are shared nodes and stay; only their source pointer is
          // cleared. Supersession chains are intentionally broken (referencing
          // rows survive with supersedes_id = NULL).
          const info = delMemoryLinks.run(id, id) as unknown as { changes: number };
          const n = Number(info.changes ?? 0);
          linksRemoved += n;
          clearRelationSource.run(id);
          clearSupersedes.run(id);
          removeSearchIndex("memories", id);
          removeEmbedding("memories", id);
          delMemory.run(id);
          removed.push(`memory #${id} (${n} link(s) removed)`);
        } else if (kind === "preferences") {
          delPreference.run(id);
          removeSearchIndex("preferences", id);
          removeEmbedding("preferences", id);
          removed.push(`preference #${id}`);
        } else if (kind === "lessons") {
          delLesson.run(id);
          removeSearchIndex("lessons", id);
          removeEmbedding("lessons", id);
          removed.push(`lesson #${id}`);
        } else {
          delInteraction.run(id);
          removeSearchIndex("interactions", id);
          removed.push(`interaction #${id}`);
        }
      }
    }).immediate();

    if (removed.length === 0) {
      return ok(`nothing found with id=${id}${args.type ? ` (${args.type})` : ""}`);
    }
    return ok(`forgot ${removed.join(", ")}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
