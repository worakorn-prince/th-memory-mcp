#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { rememberInput, rememberHandler } from "./tools/remember.js";
import { recallInput, recallHandler } from "./tools/recall.js";
import { getProfileHandler } from "./tools/profile.js";
import { saveLessonInput, saveLessonHandler } from "./tools/lesson.js";
import { searchHistoryInput, searchHistoryHandler } from "./tools/history.js";
import { forgetInput, forgetHandler } from "./tools/forget.js";
import { memoryStatsHandler } from "./tools/memory_stats.js";
import {
  recentInteractionsInput,
  getRecentInteractionsHandler,
} from "./tools/recent_interactions.js";
import {
  exportMemoryInput,
  exportMemoryHandler,
} from "./tools/export_memory.js";
import { contextInput, contextHandler } from "./tools/context.js";
import { consolidateInput, consolidateHandler } from "./tools/consolidate.js";
import { linkMemoryInput, linkMemoryHandler } from "./tools/link_memory.js";
import { mergeMemoryInput, mergeMemoryHandler } from "./tools/merge_memory.js";
import { updateMemoryInput, updateMemoryHandler } from "./tools/update_memory.js";
import { importMemoryInput, importMemoryHandler } from "./tools/import_memory.js";
import { extractMemoriesInput, extractMemoriesHandler } from "./tools/extract_memories.js";
import { VERSION } from "./lib/config.js";

const server = new McpServer({
  name: "th-memory-mcp",
  version: VERSION,
});

server.registerTool(
  "remember",
  {
    title: "Remember preference",
    description:
      "Save or update a user preference (category+key upsert). Re-saving the same key increases confidence by 0.1 (cap 1.0). Returns the row id for forget().",
    inputSchema: rememberInput,
  },
  (args) => rememberHandler(args)
);

server.registerTool(
  "recall",
  {
    title: "Recall memory",
    description:
      "Search preferences + lessons via full-text index, plus recent matching interactions. Use before starting a new task.",
    inputSchema: recallInput,
  },
  (args) => recallHandler(args)
);

server.registerTool(
  "get_profile",
  {
    title: "Get user profile",
    description:
      "Get the distilled user profile: profile sections, top preferences by confidence (max 15), and the 5 most recent lessons.",
    inputSchema: {},
  },
  () => getProfileHandler()
);

server.registerTool(
  "save_lesson",
  {
    title: "Save lesson",
    description:
      "Record a lesson learned from a correction: what situation, what mistake, what is the correct way. Call immediately after the user corrects your work.",
    inputSchema: saveLessonInput,
  },
  (args) => saveLessonHandler(args)
);

server.registerTool(
  "search_history",
  {
    title: "Search prompt history",
    description:
      "Search past user prompts (kind='prompt') by keyword. Returns timestamped snippets truncated to 200 chars each.",
    inputSchema: searchHistoryInput,
  },
  (args) => searchHistoryHandler(args)
);

server.registerTool(
  "forget",
  {
    title: "Forget a memory entry",
    description:
      "Delete one memory row (preference, lesson or interaction) by id and sync the search index. Pass type when you know it (ids from remember are preference ids, from save_lesson are lesson ids).",
    inputSchema: forgetInput,
  },
  (args) => forgetHandler(args)
);

server.registerTool(
  "memory_stats",
  {
    title: "Memory statistics",
    description:
      "Summarize memory usage: interaction counts by kind, preference/lesson totals, DB file size, oldest/newest interaction timestamps, and profile sections.",
    inputSchema: {},
  },
  () => memoryStatsHandler()
);

server.registerTool(
  "get_recent_interactions",
  {
    title: "Recent interactions",
    description:
      "List recently captured raw interactions (newest first) as [id] ts [kind] content lines. Optionally filter by kind. Use for auditing history or before distilling memory.",
    inputSchema: recentInteractionsInput,
  },
  (args) => getRecentInteractionsHandler(args)
);

server.registerTool(
  "export_memory",
  {
    title: "Export memory to JSON",
    description:
      "Export preferences, lessons, profile (and optionally raw interactions) to a JSON file under data/exports/. Only writes inside that directory. Returns the file path, size in bytes and a JSON preview.",
    inputSchema: exportMemoryInput,
  },
  (args) => exportMemoryHandler(args)
);

server.registerTool(
  "get_context",
  {
    title: "Get assembled context",
    description:
      "Assemble relevant memories for the current task via hybrid retrieval (+ optional memory-graph expansion), with token budgeting. Use to load memory into context before a task.",
    inputSchema: contextInput,
  },
  (args) => contextHandler(args)
);

server.registerTool(
  "consolidate",
  {
    title: "Consolidate memories",
    description:
      "Cluster similar memories via embedding similarity and optionally create derived/consolidated memories linked via 'derived_from'. Use during periodic consolidation.",
    inputSchema: consolidateInput,
  },
  (args) => consolidateHandler(args)
);

server.registerTool(
  "link_memory",
  {
    title: "Link two memories",
    description:
      "Create a typed relationship between two memories in the graph (supports/contradicts/supersedes/derived_from/related_to/caused_by/depends_on).",
    inputSchema: linkMemoryInput,
  },
  (args) => linkMemoryHandler(args)
);

server.registerTool(
  "merge_memory",
  {
    title: "Merge memories",
    description:
      "Merge a duplicate/near-duplicate memory into a canonical one. The source becomes superseded and provenance is recorded in metadata.merged_from.",
    inputSchema: mergeMemoryInput,
  },
  (args) => mergeMemoryHandler(args)
);

server.registerTool(
  "update_memory",
  {
    title: "Update a memory",
    description:
      "Update mutable fields (summary/importance/confidence/valid_until/metadata) in place. If content changes, a superseding memory is created by default (set supersede=false to edit in place).",
    inputSchema: updateMemoryInput,
  },
  (args) => updateMemoryHandler(args)
);

server.registerTool(
  "import_memory",
  {
    title: "Import memories",
    description:
      "Import memories from a JSON array or a .json file inside data/exports/. Validates type, dedupes against existing memories, and never overwrites active memory blindly. Dry-run by default; pass apply=true to insert.",
    inputSchema: importMemoryInput,
  },
  (args) => importMemoryHandler(args)
);

server.registerTool(
  "extract_memories",
  {
    title: "Extract memories from interactions",
    description:
      "Scan recent captured interactions for memory-intent phrases and propose memory candidates (deterministic, no LLM). Dry-run by default; pass apply=true to create them (source=captured).",
    inputSchema: extractMemoriesInput,
  },
  (args) => extractMemoriesHandler(args)
);

function isSupportedHarness(): boolean {
  const env = process.env as Record<string, string | undefined>;
  if (env.OPENCODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDECODE) return true;
  const harness = (env.MCP_HARNESS ?? env.HARNESS ?? "").toLowerCase();
  if (harness.includes("opencode") || harness.includes("claude")) return true;
  const argv = process.argv.join(" ").toLowerCase();
  if (argv.includes("opencode") || argv.includes("claude")) return true;
  return false;
}

async function main(): Promise<void> {
  if (!isSupportedHarness()) {
    console.error(
      "[th-memory-mcp] warning: running outside OpenCode/Claude Code — auto-capture unavailable, MCP tools still work. See README 'Works with other harnesses'."
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[th-memory-mcp] ready on stdio`);
}

main().catch((e) => {
  console.error("[th-memory-mcp] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
