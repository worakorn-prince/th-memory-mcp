import { z } from "zod";
import { readFileSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { db, DB_PATH, ok, err, type ToolResult } from "../db/index.js";
import { createMemory } from "../db/repositories/memories.js";
import { deduplicate } from "../memory/deduplicator.js";
import { MEMORY_TYPES } from "../memory/types.js";
import type { MemoryType, SourceType } from "../memory/types.js";
import { EXPORTS_DIRNAME } from "../lib/config.js";

export const importMemoryInput = {
  file: z
    .string()
    .optional()
    .describe("Path to a .json export file (must be inside data/exports/)"),
  json: z
    .string()
    .optional()
    .describe("Inline JSON: an array of memory objects, or { memories: [...] }"),
  apply: z
    .boolean()
    .optional()
    .describe("Actually insert memories (default false = dry run, just report)"),
};

interface ImportItem {
  type?: string;
  content?: unknown;
  summary?: unknown;
  source?: string;
  confidence?: unknown;
  importance?: unknown;
  projectId?: unknown;
  sessionId?: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
  metadata?: unknown;
}

export function importMemoryHandler(args: {
  file?: string;
  json?: string;
  apply?: boolean;
}): ToolResult {
  try {
    let raw: string;
    if (args.json) {
      raw = args.json;
    } else if (args.file) {
      const exportDir = join(dirname(DB_PATH), EXPORTS_DIRNAME);
      const full = resolve(args.file);
      const allowed = resolve(exportDir);
      if (!full.startsWith(allowed + sep))
        return err(`file must be inside ${exportDir}`);
      if (!full.endsWith(".json")) return err("file must end with .json");
      raw = readFileSync(full, "utf8");
    } else {
      return err("provide either file or json");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return err("invalid JSON");
    }
    const items: ImportItem[] = Array.isArray(parsed)
      ? (parsed as ImportItem[])
      : Array.isArray((parsed as { memories?: ImportItem[] }).memories)
        ? ((parsed as { memories: ImportItem[] }).memories)
        : [];

    let wouldImport = 0;
    let skipped = 0;
    let invalid = 0;
    const log: string[] = [];
    for (const it of items) {
      if (
        !it ||
        typeof it.content !== "string" ||
        !MEMORY_TYPES.includes(it.type as MemoryType)
      ) {
        invalid++;
        continue;
      }
      const dup = deduplicate(it.type as MemoryType, it.content);
      if (dup.verdict === "duplicate") {
        skipped++;
        log.push(`skip duplicate -> existing ${dup.existingId}`);
        continue;
      }
      wouldImport++;
      if (args.apply === true) {
        createMemory({
          type: it.type as MemoryType,
          content: it.content,
          summary:
            typeof it.summary === "string" ? it.summary : null,
          source: (it.source as SourceType) ?? "imported",
          confidence:
            typeof it.confidence === "number" ? it.confidence : 0.7,
          importance:
            typeof it.importance === "number" ? it.importance : 0.5,
          projectId:
            typeof it.projectId === "string" ? it.projectId : null,
          sessionId:
            typeof it.sessionId === "string" ? it.sessionId : null,
          validFrom:
            typeof it.validFrom === "string" ? it.validFrom : null,
          validUntil:
            typeof it.validUntil === "string" ? it.validUntil : null,
          metadata: it.metadata ?? null,
        });
      }
    }

    const mode = args.apply === true ? "applied" : "dry-run";
    const summary = `import ${mode}: ${wouldImport} to import, ${skipped} duplicate(s) skipped, ${invalid} invalid`;
    return ok(log.length ? `${summary}\n${log.join("\n")}` : summary);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
