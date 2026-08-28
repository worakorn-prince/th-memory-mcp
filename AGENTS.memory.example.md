# AGENTS.md — Memory Protocol

This project ships an MCP server `th-memory-mcp` that provides long-term memory (local SQLite). Use this protocol every session:

```markdown
## Memory Protocol
- Before starting a new/complex task: always call get_profile() and recall("<topic>") first
- When the user corrects your work or points out a mistake: call save_lesson(situation, mistake, correction) immediately
- When the user states a fixed preference/requirement: call remember(category, key, value)
- Never guess the user's preference — if recall finds nothing, ask, then remember it
- Accept memory commands in both Thai and English (the user may switch languages anytime without warning)
```

## Tools

| Tool | Use when |
|------|---------|
| `remember(category, key, value)` | user states a preference/requirement (category: work_style / coding_pref / language / domain / other) |
| `recall(topic, limit?)` | before a new task — search preferences + lessons + recent interactions |
| `get_profile()` | need a user overview (sections + top preferences + recent lessons) |
| `save_lesson(situation, mistake, correction)` | corrected/called out — record the lesson immediately |
| `search_history(query, limit?)` | want context from the user's past prompts |
| `memory_stats()` | need memory stats (counts by kind, DB size, oldest/newest, profile sections) |
| `get_recent_interactions(limit?, kind?)` | view raw recent interactions (before distill / audit) |
| `export_memory(includeInteractions?, filename?)` | export all memory to a JSON file under data/exports/ |
| `forget(target_id)` | delete wrong/stale memory (id from remember/save_lesson output) |

## Smart Distill

When the user asks "summarize memory / distill memory / summarize memory":

1. call `get_recent_interactions(limit=50)`
2. analyze real patterns — repeated preferences, lessons from corrections, working style
3. record clear patterns via `remember(category, key, value)` / `save_lesson(...)`
4. briefly summarize findings to the user

## Setup

1. Copy config from `opencode.example.json` and merge into your `opencode.json`
2. Restart OpenCode
3. Test: "Remember that I prefer pnpm" → in a new session ask which package manager you prefer
